import { MODULE_ID } from "../consts.js";
import { HandlebarsApplication, l } from "../lib/utils.js";
import {SkillTreeApplication} from "./SkillTreeApplication.js";
import {FormBuilder} from "../lib/formBuilder.js";
import { SkillRemovalRequestManager } from "./SkillRemovalRequestManager.js";

export class SkillTreeManager extends HandlebarsApplication {
    constructor() {
        super();
    }

    static get DEFAULT_OPTIONS() {
        return {
            classes: [this.APP_ID],
            tag: "div",
            window: {
                frame: true,
                positioned: true,
                title: `${MODULE_ID}.${this.APP_ID}.title`,
                icon: "fas fa-list",
                controls: [],
                minimizable: true,
                resizable: false,
                contentTag: "section",
                contentClasses: [],
            },
            actions: {},
            form: {
                handler: undefined,
                submitOnChange: false,
                closeOnSubmit: false,
            },
            position: {
                width: 560,
                height: "auto",
            },
            actions: {},
        };
    }

    static get PARTS() {
        return {
            content: {
                template: `modules/${MODULE_ID}/templates/${this.APP_ID}.hbs`,
                classes: ["scrollable"],
            },
        };
    }

    static get APP_ID() {
        return this.name
            .split(/(?=[A-Z])/)
            .join("-")
            .toLowerCase();
    }

    get APP_ID() {
        return this.constructor.APP_ID;
    }

    async _prepareContext(options) {
        const skillTrees = game.journal
            .filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
            .sort((a, b) => a.sort - b.sort)
            .map((skillTree, index, all) => ({
                id: skillTree.id,
                uuid: skillTree.uuid,
                name: skillTree.name,
                canMoveUp: index > 0,
                canMoveDown: index < all.length - 1,
            }));
        return { skillTrees };
    }

    async resolveSkillTreeFromDataset(element) {
        const uuid = element.dataset.uuid;
        const id = element.dataset.id;
        const fromUuidResult = uuid ? await fromUuid(uuid) : null;
        if (fromUuidResult) return fromUuidResult;
        if (id) return game.journal.get(id) ?? null;
        return null;
    }

    async moveSkillTree(skillTreeId, direction) {
        const sortedSkillTrees = game.journal
            .filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
            .sort((a, b) => a.sort - b.sort);

        const currentIndex = sortedSkillTrees.findIndex((skillTree) => skillTree.id === skillTreeId);
        if (currentIndex < 0) return;

        const targetIndex = currentIndex + direction;
        if (targetIndex < 0 || targetIndex >= sortedSkillTrees.length) return;

        const reorderedSkillTrees = [...sortedSkillTrees];
        const [movedSkillTree] = reorderedSkillTrees.splice(currentIndex, 1);
        reorderedSkillTrees.splice(targetIndex, 0, movedSkillTree);

        const sortDensity = CONST.SORT_INTEGER_DENSITY ?? 100000;
        const updates = reorderedSkillTrees.map((skillTree, index) => ({
            _id: skillTree.id,
            sort: (index + 1) * sortDensity,
        }));

        await JournalEntry.implementation.updateDocuments(updates);
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        const createNewButton = html.querySelector("button[name='create-new']");
        createNewButton.addEventListener("click", async () => {
            
            const data = await new FormBuilder()
                .title(l(`${MODULE_ID}.skill-tree-manager.new-skill-tree`))
                .text({name: "name", label: l(`${MODULE_ID}.skill-tree-manager.new-skill-tree-name`)})
                .render();
            if(!data) return;
            await JournalEntry.implementation.create({
                ...data,
                flags: {
                    [MODULE_ID]: {
                        isSkillTree: true,
                        linkedSkillRule: "some",
                        multipleItemsRule: "all",
                        skillStyle: "square",
                    },
                },
            })
            this.render(true);
        });

        const resyncActorsButton = html.querySelector("button[name='resync-actors']");
        resyncActorsButton?.addEventListener("click", async (event) => {
            event.preventDefault();
            const api = game.modules.get(MODULE_ID)?.API;
            if (!api?.resyncAllActorsSkillPoints) {
                ui.notifications.warn(l(`${MODULE_ID}.skill-tree-manager.resync-unavailable`));
                return;
            }

            resyncActorsButton.disabled = true;
            try {
                const result = await api.resyncAllActorsSkillPoints();
                const message = l(`${MODULE_ID}.skill-tree-manager.resync-complete`)
                    .replace("%p", `${result?.processed ?? 0}`)
                    .replace("%u", `${result?.updated ?? 0}`);
                ui.notifications.info(message);
            } catch (error) {
                console.error(error);
                ui.notifications.error(l(`${MODULE_ID}.skill-tree-manager.resync-failed`));
            } finally {
                resyncActorsButton.disabled = false;
            }
        });

        const removalRequestsButton = html.querySelector("button[name='removal-requests']");
        removalRequestsButton?.addEventListener("click", async (event) => {
            event.preventDefault();
            new SkillRemovalRequestManager().render(true);
        });

        html.querySelectorAll("button[name='edit']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const skillTree = await this.resolveSkillTreeFromDataset(event.currentTarget);
                if (!skillTree) {
                    ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                    this.render(true);
                    return;
                }
                new SkillTreeApplication(skillTree).render(true);
                this.close();
            });
        });

        html.querySelectorAll("button[name='permissions']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const skillTree = await this.resolveSkillTreeFromDataset(event.currentTarget);
                if (!skillTree) {
                    ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                    this.render(true);
                    return;
                }
                new foundry.applications.apps.DocumentOwnershipConfig({document: skillTree}).render(true);
            });
        });

        html.querySelectorAll("button[name='delete']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const skillTree = await this.resolveSkillTreeFromDataset(event.currentTarget);
                if (!skillTree) {
                    ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                    this.render(true);
                    return;
                }
                await skillTree.deleteDialog();
                this.render(true);
            });
        });

        html.querySelectorAll("button[name='move-up']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const skillTree = await this.resolveSkillTreeFromDataset(event.currentTarget);
                if (!skillTree) {
                    ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                    this.render(true);
                    return;
                }
                await this.moveSkillTree(skillTree.id, -1);
                this.render(true);
            });
        });

        html.querySelectorAll("button[name='move-down']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const skillTree = await this.resolveSkillTreeFromDataset(event.currentTarget);
                if (!skillTree) {
                    ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                    this.render(true);
                    return;
                }
                await this.moveSkillTree(skillTree.id, 1);
                this.render(true);
            });
        });
    }



    _onClose(options) {
        super._onClose(options);
    }
}