import { MODULE_ID } from "../consts.js";
import { deepClone, HandlebarsApplication, l, mergeObject } from "../lib/utils.js";
import { FormBuilder } from "../lib/formBuilder.js";

const DEFAULT_GROUP_DATA = {
    name: "New Group",
    color: "#ffffff",
    sound: "",
    image: "",
    blurBackground: false,
    minRows: 5,
    minCols: 3,
};

export const operators = {
    "greater-or-equals": ">=",
    equals: "=",
    "not-equals": "!=",
    "greater-than": ">",
    "less-than": "<",
    "less-or-equals": "<=",
};

export const reverseOperators = Object.fromEntries(Object.entries(operators).map(([key, value]) => [value, key]));

export const SKILL_LINE_WIDTH = 4;

export const DEFAULT_SKILL_DATA = {
    points: 1,
    linkedSkillRule: 0,
    mutualExclusion: 0,
    allowIncompleteProgression: 0,
    minimumPointsInGroup: 0,
    itemUuids: [],
    connectedSkills: [],
    conditionScript: "",
    onUnlockScript: "",
    color: "",
    skillStyle: "default",
    sound: "",
};

export class SkillTreeApplication extends HandlebarsApplication {
    constructor(skillTree) {
        super();
        if (typeof skillTree === "string") skillTree = fromUuidSync(skillTree);
        this.skillTree = skillTree;
    }

    static get LINKED_SKILL_RULE() {
        return {
            some: `${MODULE_ID}.skill-tree-application.linked-skill-rule-some`,
            all: `${MODULE_ID}.skill-tree-application.linked-skill-rule-all`,
        };
    }

    static get MULTIPLE_ITEMS_RULE() {
        return {
            all: `${MODULE_ID}.skill-tree-application.multiple-items-rule-all`,
            one: `${MODULE_ID}.skill-tree-application.multiple-items-rule-one`,
        };
    }

    static get SKILL_STYLE() {
        return {
            square: `${MODULE_ID}.skill-tree-application.skill-style-square`,
            circle: `${MODULE_ID}.skill-tree-application.skill-style-circle`,
        };
    }

    static get DEFAULT_OPTIONS() {
        return {
            classes: [this.APP_ID],
            tag: "div",
            window: {
                frame: true,
                positioned: true,
                title: `${MODULE_ID}.${this.APP_ID}.title`,
                icon: "fas fa-code-branch",
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
                width: "auto",
                height: "auto",
            },
            actions: {},
        };
    }

    static get PARTS() {
        return {
            content: {
                template: `modules/${MODULE_ID}/templates/${this.APP_ID}.hbs`,
                scrollable: [".skill-groups", ""],
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

    get title() {
        return l(`${MODULE_ID}.${this.APP_ID}.title`) + this.skillTree.name;
    }

    async attemptRelink(pages) {
        for (const page of pages) {
            const connectedSkills = page.getFlag(MODULE_ID, "connectedSkills") ?? [];
            const newConnectedSkills = [];
            for (const skill of connectedSkills) {
                if (!skill) {
                    newConnectedSkills.push(undefined);
                    continue;
                }
                let document;
                try {
                    document = await fromUuid(skill);
                } catch (e) {
                    newConnectedSkills.push(undefined);
                    continue;
                }
                if (!document || document.parent !== this.skillTree) {
                    const pageId = skill.split("JournalEntryPage")[1];
                    const fixed = this.skillTree.uuid + ".JournalEntryPage" + pageId;
                    newConnectedSkills.push(fixed);
                } else {
                    newConnectedSkills.push(document.uuid);
                }
            }

            const lockoutSkills = page.getFlag(MODULE_ID, "lockoutSkills") ?? [];
            const newLockoutSkills = [];
            for (const skill of lockoutSkills) {
                if (!skill) {
                    newLockoutSkills.push(undefined);
                    continue;
                }
                let document;
                try {
                    document = await fromUuid(skill);
                } catch (e) {
                    newLockoutSkills.push(undefined);
                    continue;
                }
                if (!document || document.parent !== this.skillTree) {
                    const pageId = skill.split("JournalEntryPage")[1];
                    const fixed = this.skillTree.uuid + ".JournalEntryPage" + pageId;
                    newLockoutSkills.push(fixed);
                } else {
                    newLockoutSkills.push(document.uuid);
                }
            }

            await page.setFlag(
                MODULE_ID,
                "lockoutSkills",
                newLockoutSkills.filter((s) => s),
            );

            await page.setFlag(
                MODULE_ID,
                "connectedSkills",
                newConnectedSkills.filter((s) => s),
            );
        }
    }

    async _prepareContext(options) {
        const groups = foundry.utils.deepClone(this.skillTree.getFlag(MODULE_ID, "groups") ?? []);
        //gridTemplate
        const pages = Array.from(this.skillTree.pages);
        await this.attemptRelink(pages);
        for (const group of groups) {
            let maxRow = 0;
            let maxCol = 0;
            const skills = pages.filter((p) => p.getFlag(MODULE_ID, "groupId") === group.id);
            for (const skill of skills) {
                const row = skill.getFlag(MODULE_ID, "row");
                const col = skill.getFlag(MODULE_ID, "col");
                if (row > maxRow) maxRow = row;
                if (col > maxCol) maxCol = col;
            }
            maxRow++;
            maxCol++;
            if (maxRow < group.minRows - 1) maxRow = group.minRows - 1;
            if (maxCol < group.minCols - 1) maxCol = group.minCols - 1;
            group.gridTemplate = `repeat(${maxRow + 1}, 1fr) / repeat(${maxCol + 1}, 1fr)`;

            const children = [];
            for (let i = 0; i < maxRow + 1; i++) {
                for (let j = 0; j < maxCol + 1; j++) {
                    const skill = skills.find((s) => s.getFlag(MODULE_ID, "row") === i && s.getFlag(MODULE_ID, "col") === j);
                    if (skill) {
                        const points = skill.getFlag(MODULE_ID, "points") ?? 0;
                        const tooltip = "";
                        const overrideStyle = (skill.getFlag(MODULE_ID, "skillStyle") ?? "default") !== "default";
                        const overrideStyleClass = skill.getFlag(MODULE_ID, "skillStyle") == "circle" ? "round" : "";
                        children.push({ ...skill, row: i, col: j, uuid: skill.uuid, tooltip, points: points > 1 ? points : 0, overrideStyle, overrideStyleClass });
                    } else {
                        children.push({ row: i, col: j });
                    }
                }
            }
            group.children = children;
        }

        const skillStyle = this.skillTree.getFlag(MODULE_ID, "skillStyle") ?? Object.keys(SkillTreeApplication.SKILL_STYLE)[0];

        return { groups, useCircleStyle: skillStyle === "circle" };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        html.querySelectorAll("input, select").forEach((input) => {
            input.addEventListener("change", async (event) => {
                const value = event.target.value;
                const name = event.target.name;
                await this.skillTree.setFlag(MODULE_ID, name, value);
                this.render(true);
            });
        });

        html.querySelector("button[name='new-group']").addEventListener("click", async (event) => {
            event.preventDefault();
            const currentGroups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
            const newGroup = {
                ...DEFAULT_GROUP_DATA,
                id: foundry.utils.randomID(),
            };
            currentGroups.push(newGroup);
            await this.skillTree.setFlag(MODULE_ID, "groups", currentGroups);
            this.render(true);
        });

        html.querySelector("button[name='configure-skill-tree']").addEventListener("click", async (event) => {
            event.preventDefault();
            await this.editSkillTreeForm();
        });

        html.querySelector("button[name='close']").addEventListener("click", async (event) => {
            event.preventDefault();
            this.close();
        });

        html.querySelectorAll("button[name='delete-group']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const groupId = event.currentTarget.dataset.id;
                if (
                    !(await foundry.applications.api.DialogV2.confirm({
                        window: {
                            title: l(`${MODULE_ID}.skill-tree-application.delete-group-title`),
                        },
                        content: l(`${MODULE_ID}.skill-tree-application.delete-group-content`),
                    }))
                )
                    return;
                const currentGroups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
                const newGroups = currentGroups.filter((g) => g.id !== groupId);
                await this.skillTree.setFlag(MODULE_ID, "groups", newGroups);
                this.render(true);
            });
        });

        html.querySelectorAll("button[name='edit-group']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const groupId = event.currentTarget.dataset.id;
                await this.editGroupForm(groupId);
                this.render(true);
            });
        });

        html.querySelectorAll("button[name='move-left']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const groupId = event.currentTarget.dataset.id;
                const currentGroups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
                const currentIndex = currentGroups.findIndex((g) => g.id === groupId);
                const group = currentGroups[currentIndex];
                const newIndex = currentIndex === 0 ? currentGroups.length - 1 : currentIndex - 1;
                const filtered = currentGroups.filter((g) => g.id !== groupId);
                filtered.splice(newIndex, 0, group);
                if (currentGroups.length !== filtered.length) return;
                await this.skillTree.setFlag(MODULE_ID, "groups", filtered);

                this.render(true);
            });
        });

        html.querySelectorAll("button[name='move-right']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const groupId = event.currentTarget.dataset.id;
                const currentGroups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
                const currentIndex = currentGroups.findIndex((g) => g.id === groupId);
                const group = currentGroups[currentIndex];
                const newIndex = currentIndex === currentGroups.length - 1 ? 0 : currentIndex + 1;
                const filtered = currentGroups.filter((g) => g.id !== groupId);
                filtered.splice(newIndex, 0, group);
                if (currentGroups.length !== filtered.length) return;
                await this.skillTree.setFlag(MODULE_ID, "groups", filtered);

                this.render(true);
            });
        });

        html.querySelectorAll(".skill-container").forEach((skillContainer) => {
            const isEmpty = skillContainer.classList.contains("empty");
            skillContainer.addEventListener("drop", this._onDrop.bind(this));
            skillContainer.addEventListener("dragstart", (event) => {
                event.dataTransfer.setData(
                    "text/plain",
                    JSON.stringify({
                        type: "JournalEntryPage",
                        uuid: skillContainer.dataset.uuid,
                    }),
                );
            });
            skillContainer.addEventListener("contextmenu", async (event) => {
                event.preventDefault();
                if (isEmpty) return;
                const pageUuid = skillContainer.dataset.uuid;
                const page = await fromUuid(pageUuid);
                await page.deleteDialog();
                this.render(true);
            });
            skillContainer.addEventListener("click", async (event) => {
                event.preventDefault();
                if (isEmpty) {
                    const { row, col } = skillContainer.dataset;
                    const groupId = skillContainer.closest(".skill-group").dataset.groupId;
                    await this.skillTree.createEmbeddedDocuments("JournalEntryPage", [
                        {
                            name: "New Skill",
                            src: "icons/svg/aura.svg",
                            "text.content": null,
                            flags: {
                                [MODULE_ID]: {
                                    row: parseInt(row),
                                    col: parseInt(col),
                                    groupId,
                                },
                            },
                        },
                    ]);
                } else {
                    const skillUuid = skillContainer.dataset.uuid;
                    await this.editSkillForm(skillUuid);
                }
                this.render(true);
            });
        });

        this.drawLinks();
    }

    getSkillRect(skillUuid) {
        const el = this.element.querySelector(`.skill-container[data-uuid="${skillUuid}"]`);
        if (!el) return null;
        return el.getBoundingClientRect();
    }

    async drawLinks() {
        const groups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
        const pages = Array.from(this.skillTree.pages);
        const rectCache = {};
        for (const group of groups) {
            const skills = pages.filter((p) => p.getFlag(MODULE_ID, "groupId") === group.id);
            const element = this.element.querySelector(`.skill-group[data-group-id="${group.id}"]`);

            //Draw lines between linked skills
            const svgCanvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svgCanvas.setAttribute("width", "100%");
            svgCanvas.setAttribute("height", "100%");
            const bounding = element.getBoundingClientRect();
            const elementRect = { x: bounding.x + 4, y: bounding.y + 4, width: bounding.width - 8, height: bounding.height - 8 };
            svgCanvas.setAttribute("viewBox", `0 0 ${elementRect.width} ${elementRect.height}`);
            element.appendChild(svgCanvas);
            for (const skill of skills) {
                const skillRect = rectCache[skill.uuid] ?? this.getSkillRect(skill.uuid);
                if (!skillRect) continue;
                if (skillRect) rectCache[skill.uuid] = skillRect;
                const linked = skill.getFlag(MODULE_ID, "connectedSkills") ?? [];
                for (const linkedSkill of linked) {
                    const linkedSkillRect = rectCache[linkedSkill] ?? this.getSkillRect(linkedSkill);
                    if (!linkedSkillRect) continue;
                    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                    const x1 = skillRect.x + skillRect.width / 2 - elementRect.x;
                    const y1 = skillRect.y + skillRect.height / 2 - elementRect.y;
                    const x2 = linkedSkillRect.x + linkedSkillRect.width / 2 - elementRect.x;
                    const y2 = linkedSkillRect.y + linkedSkillRect.height / 2 - elementRect.y;
                    const mx = (x1 + x2) / 2;
                    const my = (y1 + y2) / 2;

                    line.setAttribute("x1", x1);
                    line.setAttribute("y1", y1);
                    line.setAttribute("x2", x2);
                    line.setAttribute("y2", y2);
                    line.setAttribute("stroke", group.color);
                    line.setAttribute("stroke-width", SKILL_LINE_WIDTH);

                    //Draw an arrow in the middle of the line to indicate the direction of the skill
                    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    arrow.setAttribute("d", "M-3,-3 L-3,3 L3,0 Z");
                    arrow.setAttribute("fill", group.color);
                    arrow.setAttribute("stroke", "black");
                    arrow.setAttribute("stroke-width", "1");

                    arrow.setAttribute("transform", `translate(${mx}, ${my}) rotate(${(Math.atan2(y1 - y2, x1 - x2) * 180) / Math.PI})`);
                    svgCanvas.appendChild(line);
                    svgCanvas.appendChild(arrow);
                }
            }
        }
    }

    async _onDrop(event) {
        let data;
        const groupId = event.target.closest(".skill-group").dataset.groupId;
        const row = parseInt(event.target.dataset.row);
        const col = parseInt(event.target.dataset.col);
        const isEmpty = event.target.closest(".skill-container").classList.contains("empty");
        const dropTargetSkill = await fromUuid(event.target.closest(".skill-container").dataset.uuid);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return ui.notifications.error(l(`${MODULE_ID}.skill-tree-application.drop-error`));
        if (!groupId) return ui.notifications.error(l(`${MODULE_ID}.skill-tree-application.drop-error`));

        try {
            data = JSON.parse(event.dataTransfer.getData("text/plain"));
        } catch (error) {
            return;
        }
        if (data.type === "JournalEntryPage") {
            const skill = await fromUuid(data.uuid);
            if (skill.parent !== this.skillTree) return ui.notifications.error(l(`${MODULE_ID}.skill-tree-application.drop-error`));

            if (!isEmpty) {
                const skillConnectedSkills = skill.getFlag(MODULE_ID, "connectedSkills") ?? [];
                if (skillConnectedSkills.includes(dropTargetSkill.uuid)) {
                    await skill.setFlag(
                        MODULE_ID,
                        "connectedSkills",
                        skillConnectedSkills.filter((s) => s !== dropTargetSkill.uuid),
                    );
                } else {
                    await skill.setFlag(MODULE_ID, "connectedSkills", [...skillConnectedSkills, dropTargetSkill.uuid]);
                }
                this.render(true);
                return;
            }

            await skill.update({
                flags: {
                    [MODULE_ID]: {
                        row,
                        col,
                        groupId,
                    },
                },
            });
            this.render(true);
            return;
        }
        if (!data.type === "Item") return ui.notifications.error(l(`${MODULE_ID}.skill-tree-application.drop-error`));
        const itemData = await fromUuid(data.uuid);
        const diagonalClosest = [];
        const sameRowColClosest = [];
        const sameGroupSkills = this.skillTree.pages.filter((p) => p.getFlag(MODULE_ID, "groupId") === groupId);
        for (const skill of sameGroupSkills) {
            const skillRow = skill.getFlag(MODULE_ID, "row");
            const skillCol = skill.getFlag(MODULE_ID, "col");
            const isSameRow = skillRow === row && Math.abs(skillCol - col) === 1;
            const isSameCol = skillCol === col && Math.abs(skillRow - row) === 1;
            const isDiagonal = Math.abs(skillRow - row) === Math.abs(skillCol - col) && Math.abs(skillRow - row) === 1 && Math.abs(skillCol - col) === 1;
            if (isSameCol || isSameRow) sameRowColClosest.push(skill);
            else if (isDiagonal) diagonalClosest.push(skill);
        }
        let closestSkills = [];
        if (sameRowColClosest.length) closestSkills = [sameRowColClosest[0]];
        else if (diagonalClosest.length) closestSkills = diagonalClosest;
        await this.skillTree.createEmbeddedDocuments("JournalEntryPage", [
            {
                name: itemData.name,
                src: itemData.img,
                "text.content": itemData.system?.description?.value ?? "",
                flags: {
                    [MODULE_ID]: {
                        ...deepClone(DEFAULT_SKILL_DATA),
                        row,
                        col,
                        groupId,
                        itemUuids: [data.uuid],
                        connectedSkills: closestSkills.map((s) => s.uuid),
                    },
                },
            },
        ]);

        this.render(true);
    }

    async editSkillTreeForm() {
        const skillTree = this.skillTree;
        const data = await new FormBuilder()
            .title(l(`${MODULE_ID}.${this.APP_ID}.configure-skill-tree`))
            .object(skillTree)
            .text({ name: "name", label: l(`${MODULE_ID}.${this.APP_ID}.configure-skill-tree-name`) })
            .file({ name: `flags.${MODULE_ID}.pointsImage`, type: "image", label: l(`${MODULE_ID}.${this.APP_ID}.configure-skill-tree-image`), hint: l(`${MODULE_ID}.${this.APP_ID}.configure-skill-tree-image-hint`) })
            .text({ name: `flags.${MODULE_ID}.requiredClasses`, label: l(`${MODULE_ID}.${this.APP_ID}.configure-skill-tree-required-classes`), hint: l(`${MODULE_ID}.${this.APP_ID}.configure-skill-tree-required-classes-hint`) })
            .select({ name: `flags.${MODULE_ID}.linkedSkillRule`, label: l(`${MODULE_ID}.${this.APP_ID}.linked-skill-rule`), hint: l(`${MODULE_ID}.${this.APP_ID}.linked-skill-rule-hint`), options: SkillTreeApplication.LINKED_SKILL_RULE })
            .select({ name: `flags.${MODULE_ID}.multipleItemsRule`, label: l(`${MODULE_ID}.${this.APP_ID}.multiple-items-rule`), hint: l(`${MODULE_ID}.${this.APP_ID}.multiple-items-rule-hint`), options: SkillTreeApplication.MULTIPLE_ITEMS_RULE })
            .select({ name: `flags.${MODULE_ID}.skillStyle`, label: l(`${MODULE_ID}.${this.APP_ID}.skill-style`), hint: l(`${MODULE_ID}.${this.APP_ID}.skill-style-hint`), options: SkillTreeApplication.SKILL_STYLE })
            .checkbox({ name: `flags.${MODULE_ID}.independentSkillPoints`, label: l(`${MODULE_ID}.${this.APP_ID}.independent-skill-points`), hint: l(`${MODULE_ID}.${this.APP_ID}.independent-skill-points-hint`) })
            .checkbox({ name: `flags.${MODULE_ID}.showSkillPointsInGroup`, label: l(`${MODULE_ID}.${this.APP_ID}.show-skill-points-in-group`), hint: l(`${MODULE_ID}.${this.APP_ID}.show-skill-points-in-group-hint`) })
            .render();
        if (!data) return;

        const rawRequiredClasses = data?.flags?.[MODULE_ID]?.requiredClasses;
        if (typeof rawRequiredClasses === "string") {
            data.flags[MODULE_ID].requiredClasses = rawRequiredClasses
                .split(",")
                .map((className) => className.trim().toLowerCase())
                .filter((className) => className.length > 0);
        } else if (!Array.isArray(rawRequiredClasses)) {
            data.flags[MODULE_ID].requiredClasses = [];
        }

        await this.skillTree.update(data);
        this.render(true);
    }

    async editGroupForm(groupId) {
        const groupData = deepClone(this.skillTree.getFlag(MODULE_ID, "groups").find((g) => g.id === groupId));
        const data = await new FormBuilder()
            .object(groupData)
            .title(l(`${MODULE_ID}.${this.APP_ID}.edit-group-title`) + groupData.name)
            .text({ name: "name", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-name`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-name-hint`) })
            .color({ name: "color", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-color`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-color-hint`) })
            .file({ name: "image", type: "image", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-image`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-image-hint`) })
            .checkbox({ name: "blurBackground", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-blur-background`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-blur-background-hint`) })
            .file({ name: "sound", type: "audio", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-sound`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-sound-hint`) })
            .number({ name: "minRows", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-min-rows`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-min-rows-hint`) })
            .number({ name: "minCols", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-min-cols`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-min-cols-hint`) })
            .render();

        const newData = { ...groupData, ...data };
        const oldGroups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
        const newGroups = oldGroups.map((g) => (g.id === groupId ? newData : g));
        await this.skillTree.setFlag(MODULE_ID, "groups", newGroups);
    }

    async editSkillForm(skillUuid) {
        const page = await fromUuid(skillUuid);
        const fb = new FormBuilder();
        fb.object(page)
            .tab({ id: "aspect", icon: "fas fa-image", label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-aspect-tab`) })
            .title(l(`${MODULE_ID}.${this.APP_ID}.edit-skill-title`) + page.name)
            .text({ name: `name`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-name`) })
            .file({ name: `src`, type: "image", label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-image`) })
            .color({ name: `flags.${MODULE_ID}.color`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-color`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-color-hint`) }) //
            .select({ name: `flags.${MODULE_ID}.skillStyle`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-style`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-style-hint`), options: { default: `${MODULE_ID}.${this.APP_ID}.edit-skill-style-default`, ...SkillTreeApplication.SKILL_STYLE } })
            .file({ name: `flags.${MODULE_ID}.sound`, type: "audio", label: l(`${MODULE_ID}.${this.APP_ID}.edit-group-sound`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-group-sound-hint`) })
            .tab({ id: "behavior", icon: "fas fa-cogs", label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-behavior-tab`) })
            .number({ name: `flags.${MODULE_ID}.points`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-points`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-points-hint`) })
            .number({name: `flags.${MODULE_ID}.allowIncompleteProgression`, label: l(`${MODULE_ID}.${this.APP_ID}.allow-incomplete-progression`), hint: l(`${MODULE_ID}.${this.APP_ID}.allow-incomplete-progression-hint`) })
            .number({name: `flags.${MODULE_ID}.linkedSkillRule`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-linked-skill-rule`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-linked-skill-rule-hint`)})
            .number({ name: `flags.${MODULE_ID}.mutualExclusion`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-mutual-exclusion`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-mutual-exclusion-hint`) })
            .number({ name: `flags.${MODULE_ID}.minimumPointsInGroup`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-minimum-points-in-group`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-minimum-points-in-group-hint`) })
            .uuid({ name: `flags.${MODULE_ID}.itemUuids`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-item`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-item-hint`), type: "Item", multiple: true })
            .uuid({ name: `flags.${MODULE_ID}.connectedSkills`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-connected-skills`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-connected-skills-hint`), type: "JournalEntryPage", multiple: true })
            .uuid({ name: `flags.${MODULE_ID}.lockoutSkills`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-lockout-skills`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-lockout-skills-hint`), type: "JournalEntryPage", multiple: true })
            .tab({ id: "requirements", icon: "fas fa-list-check", label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-requirements-tab`) })
            .html(this.getSkillRequirementsHtml(page))
            .onRender(this.setupSkillFormInteractivity)
            .tab({ id: "scripts", icon: "fas fa-code", label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-scripts-tab`) })
            .script({ name: `flags.${MODULE_ID}.conditionScript`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-condition-script`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-condition-script-hint`) })
            .script({ name: `flags.${MODULE_ID}.onUnlockScript`, label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-on-unlock`), hint: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-on-unlock-hint`) })
            .button({
                label: l(`${MODULE_ID}.${this.APP_ID}.edit-skill-edit-tooltip-button`),
                callback: async () => {
                    page.sheet.render(true);
                },
                icon: "fas fa-edit",
            })
            .button({
                label: l(`Delete`),
                callback: async () => {
                    fb.form().close();
                    await page.deleteDialog();
                    this.render(true);
                },
                icon: "fas fa-trash",
            });
        const data = await fb.render();
        if (!data) return;
        if (data.flags[MODULE_ID].requirements) {
            if (typeof data.flags[MODULE_ID].requirements.label === "string") {
                data.flags[MODULE_ID].requirements.label = [data.flags[MODULE_ID].requirements.label];
                data.flags[MODULE_ID].requirements.attribute = [data.flags[MODULE_ID].requirements.attribute];
                data.flags[MODULE_ID].requirements.operator = [data.flags[MODULE_ID].requirements.operator];
                data.flags[MODULE_ID].requirements.value = [data.flags[MODULE_ID].requirements.value];
            }
            const requirementsCount = data.flags[MODULE_ID].requirements.label.length;
            const requirements = [];
            for (let i = 0; i < requirementsCount; i++) {
                const label = data.flags[MODULE_ID].requirements.label[i];
                const attribute = data.flags[MODULE_ID].requirements.attribute[i];
                const operator = data.flags[MODULE_ID].requirements.operator[i];
                const value = data.flags[MODULE_ID].requirements.value[i];
                requirements.push({ label, attribute, operator, value });
            }
            data.flags[MODULE_ID].requirements = requirements;
        } else {
            data.flags[MODULE_ID].requirements = [];
        }
        if (data.flags[MODULE_ID].points < 1 || !data.flags[MODULE_ID].points) data.flags[MODULE_ID].points = 1;
        data.flags[MODULE_ID].connectedSkills = data.flags[MODULE_ID].connectedSkills.filter((s) => s !== skillUuid);
        await page.update(data);
        this.render(true);
    }

    getSkillRequirementsHtml(skill) {
        const requirements = skill.getFlag(MODULE_ID, "requirements") ?? [];
        let html = `<table class="skill-requirements" style="margin: 0;">
        <thead>
            <tr>
                <th>${l(`${MODULE_ID}.${this.APP_ID}.edit-skill-requirement-label`)}</th>
                <th>${l(`${MODULE_ID}.${this.APP_ID}.edit-skill-requirement-attribute`)}</th>
                <th>${l(`${MODULE_ID}.${this.APP_ID}.edit-skill-requirement-operator`)}</th>
                <th>${l(`${MODULE_ID}.${this.APP_ID}.edit-skill-requirement-value`)}</th>
                <th><button type="button" name="add-requirement"><i class="fas fa-plus"></i></button></th>
            </tr>
        </thead>
        <tbody>`;

        for (const requirement of requirements) {
            html += `<tr>
                <td><input type="text" name="flags.${MODULE_ID}.requirements.label" value="${requirement.label}" /></td>
                <td><input type="text" name="flags.${MODULE_ID}.requirements.attribute" value="${requirement.attribute}" /></td>
                <td><select name="flags.${MODULE_ID}.requirements.operator">
                    ${Object.entries(operators)
                        .map(([key, value]) => `<option ${key === requirement.operator ? "selected" : ""} value="${key}">${value}</option>`)
                        .join("")}
                </select></td>
                <td><input type="text" name="flags.${MODULE_ID}.requirements.value" value="${requirement.value}" /></td>
                <td><button type="button" id="delete-requirement"><i class="fas fa-trash"></i></button></td>
            </tr>`;
        }
        html += `</tbody>
        </table>`;
        return html;
    }

    setupSkillFormInteractivity() {
        const table = this.element.querySelector(".skill-requirements");
        const addButton = table.querySelector("button[name='add-requirement']");
        const deleteButton = table.querySelectorAll("button[id='delete-requirement']");
        deleteButton.forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const row = button.closest("tr");
                row.remove();
            });
        });

        addButton.addEventListener("click", async (event) => {
            event.preventDefault();
            const row = table.insertRow(table.rows.length);
            row.innerHTML = `<td><input type="text" name="flags.${MODULE_ID}.requirements.label" /></td>
            <td><input type="text" name="flags.${MODULE_ID}.requirements.attribute" /></td>
            <td><select name="flags.${MODULE_ID}.requirements.operator">
                ${Object.entries(operators)
                    .map(([key, value]) => `<option value="${key}">${value}</option>`)
                    .join("")}
            </select></td>
            <td><input type="text" name="flags.${MODULE_ID}.requirements.value" /></td>
            <td><button type="button" id="delete-requirement"><i class="fas fa-trash"></i></button></td>`;
        });
    }

    _onClose(options) {
        super._onClose(options);
    }
}
