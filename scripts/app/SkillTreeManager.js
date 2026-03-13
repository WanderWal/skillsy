import { MODULE_ID } from "./consts.js";
import { HandlebarsApplication, l } from "../lib/utils.js";
import {SkillTreeApplication} from "./SkillTreeApplication.js";
import {FormBuilder} from "../lib/formBuilder.js";

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
        const skillTrees = game.journal.filter(j => j.getFlag(MODULE_ID, "isSkillTree")).sort((a, b) => a.sort - b.sort);
        return { skillTrees };
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
        html.querySelectorAll("button[name='edit']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const uuid = event.currentTarget.dataset.uuid;
                const skillTree = await fromUuid(uuid);
                new SkillTreeApplication(skillTree).render(true);
                this.close();
            });
        });

        html.querySelectorAll("button[name='permissions']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const uuid = event.currentTarget.dataset.uuid;
                const skillTree = await fromUuid(uuid);
                new foundry.applications.apps.DocumentOwnershipConfig({document: skillTree}).render(true);
            });
        });

        html.querySelectorAll("button[name='delete']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const uuid = event.currentTarget.dataset.uuid;
                const skillTree = await fromUuid(uuid);
                await skillTree.deleteDialog();
                this.render(true);
            });
        });
    }



    _onClose(options) {
        super._onClose(options);
    }
}