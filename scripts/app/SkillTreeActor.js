import { MODULE_ID } from "./consts.js";
import { deepClone, getProperty, HandlebarsApplication, l, mergeClone, mergeObject } from "../lib/utils.js";
import { FormBuilder } from "../lib/formBuilder.js";
import { DEFAULT_SKILL_DATA, SKILL_LINE_WIDTH, SkillTreeApplication, reverseOperators } from "./SkillTreeApplication.js";
import {getSetting, setSetting} from "../settings.js";

let dbOperationsPending = false;

function normalizeStringList(values) {
    const list = Array.isArray(values) ? values : [values];
    return list
        .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
        .filter((value) => value.length > 0);
}

export function getActorClassIdentifiers(actor) {
    const classes = new Set();
    const classItems = actor?.itemTypes?.class ?? actor?.items?.filter((item) => item.type === "class") ?? [];

    for (const classItem of classItems) {
        const candidates = [
            classItem.identifier,
            classItem.system?.identifier,
            classItem.system?.slug,
            classItem.slug,
            classItem.name,
        ];
        for (const candidate of candidates) {
            const normalized = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
            if (normalized) classes.add(normalized);
        }
    }

    const detailsClass = actor?.system?.details?.class?.value;
    if (typeof detailsClass === "string") {
        for (const part of detailsClass.split(",")) {
            const normalized = part.trim().toLowerCase();
            if (normalized) classes.add(normalized);
        }
    }

    return classes;
}

export function skillTreeMatchesActorRequirements(skillTree, actor) {
    const requiredClasses = normalizeStringList(skillTree.getFlag(MODULE_ID, "requiredClasses") ?? []);
    if (!requiredClasses.length) return true;
    const actorClasses = getActorClassIdentifiers(actor);
    return requiredClasses.some((requiredClass) => actorClasses.has(requiredClass));
}

export function getSkillPoints(actor, skillTree) {
    const independent = skillTree?.getFlag(MODULE_ID, "independentSkillPoints");
    if (independent) return actor.getFlag(MODULE_ID, `skillTreeSkillPoints.${skillTree.id}`) ?? 0;
    return actor.getFlag(MODULE_ID, "skillPoints") ?? 0;
}

export function setSkillPoints(actor, skillTree, value) {
    value = parseInt(value);
    const independent = skillTree?.getFlag(MODULE_ID, "independentSkillPoints");
    if (independent) return actor.setFlag(MODULE_ID, `skillTreeSkillPoints.${skillTree.id}`, value);
    else return actor.setFlag(MODULE_ID, "skillPoints", parseInt(value));
}

export function getSkillTreePoints(actor, skillTree) {
    const points = getSkillPoints(actor, skillTree);
    const actorSkills = actor.getFlag(MODULE_ID, "skills") ?? [];
    const groups = skillTree.getFlag(MODULE_ID, "groups") ?? [];
    const totalPoints = {

    }
    groups.forEach((group) => {
        totalPoints[group.id] = 0;
    });

    const pages = Array.from(skillTree.pages);
    pages.forEach((page) => {
        const groupId = page.flags[MODULE_ID]?.groupId;
        if (totalPoints[groupId] !== undefined) totalPoints[groupId] += actorSkills.find((s) => s.uuid === page.uuid)?.points ?? 0;
    });

    const totalSkillTreePoints = Object.values(totalPoints).reduce((a, b) => a + b, 0) + points;

    return {...totalPoints, total: totalSkillTreePoints};

}

export class SkillTreeActor extends HandlebarsApplication {
    constructor(actor) {
        super();
        this.actor = typeof actor === "string" ? fromUuidSync(actor) : actor;
        this.skills = new Map();
        this.hookId = Hooks.on("updateJournalEntry", (document, update) => {
            if (document === this.skillTree) this.render(true);
        });
        this.pageHookId = Hooks.on("updateJournalEntryPage", (document, update) => {
            if (document.parent === this.skillTree) this.render(true);
        });
        this.actorHookId = Hooks.on("updateActor", (document, update) => {
            if (document === this.actor) this.render(true);
        });
    }

    static get LINKED_SKILL_RULE() {
        return {
            some: `${MODULE_ID}.skill-tree-application.linked-skill-rule-some`,
            all: `${MODULE_ID}.skill-tree-application.linked-skill-rule-all`,
        };
    }

    static get _ITEMS_RULE() {
        return {
            all: `${MODULE_ID}.skill-tree-application.-items-rule-all`,
            one: `${MODULE_ID}.skill-tree-application.-items-rule-one`,
        };
    }

    static get DEFAULT_OPTIONS() {
        const useFullscreen = false; //getSetting("useFullscreen");
        return {
            classes: useFullscreen ? [this.APP_ID, "fullscreen"] : [this.APP_ID],
            tag: "div",
            window: {
                frame: true,
                positioned: true,
                title: `${MODULE_ID}.${this.APP_ID}.title`,
                icon: "fas fa-code-branch",
                controls: [
                    /*{
                        icon: "fas fa-expand-arrows-alt",
                        label: `${MODULE_ID}.${this.APP_ID}.toggle-fullscreen`,
                        action: "toggle-fullscreen",
                    }*/
                ],
                minimizable: true,
                resizable: false,
                contentTag: "section",
                contentClasses: [],
            },
            actions: {
                "toggle-fullscreen": () => {
                    setSetting("useFullscreen", !getSetting("useFullscreen"));
                }
            },
            form: {
                handler: undefined,
                submitOnChange: false,
                closeOnSubmit: false,
            },
            position: {
                width: "auto",
                height: "auto",
            },
        };
    }

    static get PARTS() {
        return {
            content: {
                template: `modules/${MODULE_ID}/templates/${this.APP_ID}.hbs`,
                scrollable: [".skill-groups"],
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
        return l(`${MODULE_ID}.${this.APP_ID}.title`) + this.actor.name;
    }

    async _prepareContext(options) {
        const skillTrees = game.journal
            .filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
            .sort((a, b) => a.sort - b.sort)
            .filter((j) => j.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER))
            .filter((j) => skillTreeMatchesActorRequirements(j, this.actor));

        const selectedSkillTreeUuid = this.actor.getFlag(MODULE_ID, "selectedSkillTree");
        const selectedSkillTree = selectedSkillTreeUuid ? await fromUuid(selectedSkillTreeUuid) : null;
        this.skillTree = selectedSkillTree && skillTrees.some((tree) => tree.uuid === selectedSkillTree.uuid) ? selectedSkillTree : skillTrees[0];

        if (!this.skillTree) return {};

        const groups = foundry.utils.deepClone(this.skillTree.getFlag(MODULE_ID, "groups") ?? []);
        //gridTemplate
        const pages = Array.from(this.skillTree.pages);

        this.skills = new Map();
        const promises = [];
        pages.forEach((page) => {
            const skill = new Skill(page, this.actor, this.skills);
            this.skills.set(page.uuid, skill);
            promises.push(skill.computeCanBeUnlocked());
        });

        await Promise.all(promises);

        const totalPoints = getSkillTreePoints(this.actor, this.skillTree);

        const showSkillPointsInGroup = this.skillTree.getFlag(MODULE_ID, "showSkillPointsInGroup") ?? false;

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
            if (maxRow < group.minRows - 1) maxRow = group.minRows - 1;
            if (maxCol < group.minCols - 1) maxCol = group.minCols - 1;
            group.gridTemplate = `repeat(${maxRow + 1}, 1fr) / repeat(${maxCol + 1}, 1fr)`;

            const children = [];
            for (let i = 0; i < maxRow + 1; i++) {
                for (let j = 0; j < maxCol + 1; j++) {
                    const skill = skills.find((s) => s.getFlag(MODULE_ID, "row") === i && s.getFlag(MODULE_ID, "col") === j);
                    if (skill) {
                        const skillHelper = this.skills.get(skill.uuid);
                        const mutualExclusion = skill.getFlag(MODULE_ID, "mutualExclusion") ?? 0;
                        const mutualExclusionText = mutualExclusion ? `<p class="mutual-exclusion">${l(`${MODULE_ID}.skill-tree-actor.mutual-exclusion-info`).replace("%n", mutualExclusion)}</p>` : "";
                        const tierText = skill.tier ? ` (${skill.tier})` : "";
                        let requirements = (skill.getFlag(MODULE_ID, "requirements") ?? []).map((r, i) => `<span class="requirement ${skillHelper.isValidRequirement(i) ? "valid" : "invalid"}">${r.label} ${r.value}</span>`).join("<br>");
                        const requiresMorePointsInGroup = skillHelper.requiresMorePointsInGroup;
                        if(requiresMorePointsInGroup) requirements += (`<span class="requirement">${skillHelper.group.name} ${requiresMorePointsInGroup}</span>`);
                        if (requirements.length) requirements = `<span>${l(`${MODULE_ID}.skill-tree-actor.prerequisites`)}</span><br>${requirements}`;
                        const tooltip = await foundry.applications.ux.TextEditor.implementation.enrichHTML(`<figure><img src='${skill.src}'><h1>${skill.name}${tierText}</h1></figure><div class="skill-requirements">${requirements}</div>${mutualExclusionText}${skill.text.content ?? ""}`);
                        children.push({ ...skill, row: i, col: j, uuid: skill.uuid, tooltip, skillHelper: this.skills.get(skill.uuid) });
                    } else {
                        children.push({ row: i, col: j });
                    }
                }
            }
            group.children = children;
            group.totalPoints = totalPoints[group.id];
            group.hideTotal = groups.length < 2 || !showSkillPointsInGroup;
        }


        const skillTreesOptions = skillTrees.map((skillTree) => ({ key: skillTree.uuid, label: skillTree.name, selected: skillTree.uuid === this.skillTree.uuid }));

        const skillPoints = getSkillPoints(this.actor, this.skillTree);

        const skillStyle = this.skillTree.getFlag(MODULE_ID, "skillStyle") ?? Object.keys(SkillTreeApplication.SKILL_STYLE)[0];

        const canEditPoints = game.user.isGM || !getSetting("playersCantEditPoints");

        const pointsImage = this.skillTree.getFlag(MODULE_ID, "pointsImage");

        return { groups, skillTreesOptions, skillPoints, skillTreeName: this.skillTree.name, useCircleStyle: skillStyle === "circle", canEditPoints, pointsImage, skillTreePoints: totalPoints.total };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        html.querySelectorAll("input, select").forEach((input) => {
            input.addEventListener("change", async (event) => {
                const value = event.target.value;
                const name = event.target.name;
                if (name === "skillPoints") {
                    await setSkillPoints(this.actor, this.skillTree, value);
                } else {
                    await this.actor.setFlag(MODULE_ID, name, value);
                }
                this.render(true);
            });
        });

        html.querySelectorAll(".skill-container").forEach((skillContainer) => {
            skillContainer.addEventListener("contextmenu", async (event) => {
                event.preventDefault();
                if (dbOperationsPending) return;
                const skillUuid = skillContainer.dataset.uuid;
                const skill = this.skills.get(skillUuid);
                if (!skill.points.value) return;
                dbOperationsPending = true;
                await skill.modifyPoints(-1);
                dbOperationsPending = false;
                this.render(true);
            });
            skillContainer.addEventListener("click", async (event) => {
                event.preventDefault();
                if (dbOperationsPending) return;
                const skillUuid = skillContainer.dataset.uuid;
                const skill = this.skills.get(skillUuid);
                if (!skill.canBeUnlocked) return;
                dbOperationsPending = true;
                await skill.modifyPoints(1);
                dbOperationsPending = false;
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
                if (skillRect) rectCache[skill.uuid] = skillRect;
                const linked = skill.getFlag(MODULE_ID, "connectedSkills") ?? [];
                for (const linkedSkill of linked) {
                    try {
                        const linkedSkillRect = rectCache[linkedSkill] ?? this.getSkillRect(linkedSkill);
                        if(!linkedSkillRect) continue;
                        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                        const x1 = skillRect.x + skillRect.width / 2 - elementRect.x;
                        const y1 = skillRect.y + skillRect.height / 2 - elementRect.y;
                        const x2 = linkedSkillRect.x + linkedSkillRect.width / 2 - elementRect.x;
                        const y2 = linkedSkillRect.y + linkedSkillRect.height / 2 - elementRect.y;

                        line.setAttribute("x1", x1);
                        line.setAttribute("y1", y1);
                        line.setAttribute("x2", x2);
                        line.setAttribute("y2", y2);
                        line.setAttribute("stroke", group.color);
                        line.setAttribute("stroke-width", SKILL_LINE_WIDTH);

                        if (!(this.skills.get(skill.uuid).isUnlocked && this.skills.get(linkedSkill).isUnlocked)) line.style.filter = "grayscale(1)";

                        svgCanvas.appendChild(line);
                    } catch (e) {}
                }
            }
        }
    }

    _onClose(options) {
        super._onClose(options);
        Hooks.off("updateJournalEntry", this.hookId);
        Hooks.off("updateJournalEntryPage", this.pageHookId);
        Hooks.off("updateActor", this.actorHookId);
    }

    toggleFullscreen(toggle) {
        this.element.classList.toggle("fullscreen", toggle);
    }
}

class Skill {
    constructor(skill, actor, allSkills) {
        this.allSkills = allSkills;
        this.skill = skill;
        this.skillTree = skill.parent;
        this.actor = actor;
        this.actorSkills = this.actor.getFlag(MODULE_ID, "skills") ?? [];
        if (!Array.isArray(this.actorSkills)) this.actorSkills = [];
        this.skillData = mergeClone(DEFAULT_SKILL_DATA, this.skill.flags[MODULE_ID]);
        if (!this.skillData.points || this.skillData.points < 1) this.skillData.points = 1;
        this.skillTreeData = deepClone(this.skillTree.flags[MODULE_ID]);
        this.group = deepClone(this.skillTree.getFlag(MODULE_ID, "groups").find((g) => g.id === this.skill.getFlag(MODULE_ID, "groupId")));
        if(!this.group) {
            console.warn(`Skill ${this.skill.name} is not in a group. It's recommended you delete it from the skill tree journal. You can use the macro command fromUuidSync("${this.skill.uuid}").delete()`, this.skill);
        }
    }

    #canBeUnlocked = null;

    get pointsInGroup() {
        const skillTreePoints = getSkillTreePoints(this.actor, this.skillTree);
        const pointsInGroup = skillTreePoints[this.group?.id] ?? 0;
        return pointsInGroup;
    }

    get requiresMorePointsInGroup() {
        const minimumPointsInGroup = this.skillData.minimumPointsInGroup || 0;
        return minimumPointsInGroup > 0 && this.pointsInGroup < minimumPointsInGroup ? minimumPointsInGroup : false;
    }

    get canBeUnlocked() {
        return this.isUnlocked || this.#canBeUnlocked;
    }

    get overrideStyle() {
        return this.skillData.skillStyle !== "default";
    }

    get overrideStyleClass() {
        return this.skillData.skillStyle === "circle" ? "round" : "";
    }

    async computeCanBeUnlocked() {
        const {connectedSkills, linkedSkillRule, mutualExclusion} = this.skillData;

        const requirements = this.skillData.requirements ?? [];
        if (requirements.length && !requirements.every((r, i) => this.isValidRequirement(i))) {
            this.#canBeUnlocked = false;
            return;
        }

        const minimumPointsInGroup = this.skillData.minimumPointsInGroup || 0;
        if (minimumPointsInGroup > 0 && this.pointsInGroup < minimumPointsInGroup) {
            this.#canBeUnlocked = false;
            return;
        }

        const evaluatedCondition = await this.evaluateScriptCondition();

        // First we check against the evaluated condition
        if (!evaluatedCondition) {
            this.#canBeUnlocked = false;
            return;
        }

        // Now we check if any of the skills in the lockout list are unlocked
        const lockoutSkills = this.skillData.lockoutSkills ?? [];
        if (lockoutSkills.some((s) => this.allSkills.get(s)?.isUnlocked)) {
            this.#canBeUnlocked = false;
            return;
        }

        // Then we check if there are no linked skills, making this skill unlockable
        if (!connectedSkills.length) {
            this.#canBeUnlocked = evaluatedCondition;
            return;
        }

        // Now we check the linked skill rule
        const skillTreeLinkedSkillRule = this.skillTreeData.linkedSkillRule ?? "some";

        const linkedSkillMergedRule = linkedSkillRule || skillTreeLinkedSkillRule;

        const linkedSkills = connectedSkills.map((s) => this.allSkills.get(s)).filter((s) => s);

        let linkedSkillRuleResult = false;
        if (linkedSkillMergedRule === "some") {
            linkedSkillRuleResult = linkedSkills.some((s) => s.isUnlocked);
        } else if (linkedSkillMergedRule === "all") {
            linkedSkillRuleResult = linkedSkills.every((s) => s.isUnlocked);
        } else {
            const unlockedCount = linkedSkills.filter((s) => s.isUnlocked).length;
            linkedSkillRuleResult = unlockedCount >= linkedSkillMergedRule;
        }

        if (!mutualExclusion || !linkedSkillRuleResult) {
            this.#canBeUnlocked = linkedSkillRuleResult;
            return;
        }

        const sameRequirementSkillsCount = this.sameRequirementSkills.filter((s) => s.isUnlocked).length;

        this.#canBeUnlocked = linkedSkillRuleResult && sameRequirementSkillsCount < parseInt(mutualExclusion);

        return;
    }

    get sameRequirementSkills() {
        const { connectedSkills } = this.skillData;
        const skillsWithAtLeastOneSameRequiredSkill = Array.from(this.allSkills)
            .map((e) => e[1])
            .filter((s) => connectedSkills.some((c) => s.skillData.connectedSkills.includes(c)));
        return skillsWithAtLeastOneSameRequiredSkill.filter((s) => s !== this);
    }

    get excluded() {
        if (!this.skillData.mutualExclusion && !this.skillData.lockoutSkills) return false;
        const sameRequirementSkillsCount = this.sameRequirementSkills.filter((s) => s.isUnlocked).length;
        const mutuallyExcluded = this.skillData.mutualExclusion?.length && sameRequirementSkillsCount >= parseInt(this.skillData.mutualExclusion);
        const lockedOut =  this.skillData.lockoutSkills?.length && this.skillData.lockoutSkills.some((s) => this.allSkills.get(s)?.isUnlocked);
        return mutuallyExcluded || lockedOut;
    }

    isValidRequirement(i) {
        const requirements = this.skillData.requirements ?? [];
        const requirement = requirements[i];
        if (!requirement) return true;
        const attribute = requirement.attribute;
        if (!attribute) return true;
        const operator = requirement.operator;
        const value = requirement.value;
        const currentValue = getProperty(this.actor, attribute) ?? getProperty(this.actor.system, attribute.replace("@", ""));
        if (currentValue === undefined) return false;
        switch (operator) {
            case "equals":
                return currentValue == value;
            case "not-equals":
                return currentValue != value;
            case "greater-than":
                return currentValue > value;
            case "less-than":
                return currentValue < value;
            case "greater-or-equals":
                return currentValue >= value;
            case "less-or-equals":
                return currentValue <= value;
            default:
                return false;
        }
    }

    async evaluateScriptCondition() {
        let { conditionScript } = this.skillData;
        if (!conditionScript) return true;

        conditionScript = conditionScript.replaceAll("@", "actor.system.");

        const AsyncFunction = async function () {}.constructor;
        const fn = new AsyncFunction("actor", "skill", "group", "skillTree", conditionScript.includes("return") ? conditionScript : `return ${conditionScript}`);
        try {
            const res = await fn(this.actor, this.skill, this.group, this.skillTree);
            return !!res;
        } catch (e) {
            ui.notifications.error("There was an error in your macro syntax. See the console (F12) for details");
            console.error(e);
            return false;
        }
    }

    get isUnlocked() {
        const allowIncompleteProgression = this.skillData.allowIncompleteProgression || 0;
        if(allowIncompleteProgression && this.points.value >= allowIncompleteProgression) return true;
        return this.isTiered ? this.points.value >= 1 : this.points.value >= this.points.max;
    }

    get points() {
        const value = parseInt(this.actorSkills.find((s) => s.uuid === this.skill.uuid)?.points ?? 0);
        const max = parseInt(this.skill.getFlag(MODULE_ID, "points") ?? 1);
        return { value, max };
    }

    get showPointsCount() {
        return this.points.max > 1;
    }

    get tier() {
        const itemCount = this.skillData.itemUuids?.length ?? 0;
        if (itemCount <= 1) return null;
        const { max, value } = this.points;
        if (max <= 1) return null;
        const pointsPerItem = Math.ceil(max / itemCount);
        const tier = Math.ceil(value / pointsPerItem);
        if (tier >= 1) return tier;
        return null;
    }

    get isTiered() {
        const linkedItemsCount = this.skillData.itemUuids?.length ?? 0;
        return linkedItemsCount > 1 && this.points.max > 1;
    }

    async modifyPoints(modifyValue) {
        if (!game.user.isGM && getSetting("playersCantRemovePoints") && modifyValue < 0) return false;
        const wasUnlocked = this.isUnlocked;
        const { value, max } = this.points;
        const currentSkill = this.actorSkills.find((s) => s.uuid === this.skill.uuid) ?? { uuid: this.skill.uuid, points: 0 };
        const newPoints = value + modifyValue;
        const newActorPoints = parseInt(getSkillPoints(this.actor, this.skillTree)) - modifyValue;
        if (newActorPoints < 0) return false;
        if (newPoints > max) return false;
        if (newPoints < 0) return false;
        const skipRemovalCheck = this.isTiered && newPoints > 0;
        if (modifyValue < 0 && !skipRemovalCheck) {
            const allowIncompleteProgression = this.skillData.allowIncompleteProgression || 0;
            const allowRemovalDueToIncompleteProgression = allowIncompleteProgression && newPoints >= allowIncompleteProgression;
            const skillsThatRequireThisSkill = Array.from(this.allSkills)
                .map((s) => s[1])
                .filter((s) => s.skillData.connectedSkills.includes(this.skill.uuid));
            if (!allowRemovalDueToIncompleteProgression && skillsThatRequireThisSkill.length > 0 && skillsThatRequireThisSkill.some((s) => s.isUnlocked)) return false;
        }

        currentSkill.points = newPoints;
        this.actorSkills = this.actorSkills.filter((s) => s.uuid !== this.skill.uuid);
        this.actorSkills.push(currentSkill);
        await this.actor.setFlag(MODULE_ID, "skills", this.actorSkills);
        await setSkillPoints(this.actor, this.skillTree, newActorPoints);
        if (!wasUnlocked && this.isUnlocked) this.playSound();
        await this.updateItems({soundPlayed: !wasUnlocked && this.isUnlocked});
        await this.executeUnlockScript();
        return true;
    }

    async getItems() {
        const uuids = this.skillData.itemUuids ?? [];
        const items = [];
        for (const uuid of uuids) {
            const item = await fromUuid(uuid);
            if(!item) {
                ui.notifications.error(l(`${MODULE_ID}.skill-tree-actor.item-not-found`).replace("%s", uuid));
                continue;
            }
            items.push(item);
        }
        return items;
    }

    async updateItems({soundPlayed = false} = {}) {
        const { max } = this.points;
        const current = (this.actor.getFlag(MODULE_ID, "skills") ?? []).find((s) => s.uuid === this.skill.uuid)?.points ?? 0;
        const items = await this.getItems();
        const tier = this.tier;
        const itemsToRemove = [];
        const itemsToAdd = [];
        if (tier === null) {
            if (current === max) itemsToAdd.push(...items);
            else itemsToRemove.push(...items);
        } else {
            const multipleItemsRule = this.skillTreeData.multipleItemsRule || "all";
            const itemsUnlocked = items.filter((item, index) => index < tier);
            const tierItem = items[tier - 1];
            if (multipleItemsRule === "all") {
                itemsToAdd.push(...itemsUnlocked.filter((item) => !this.actor.items.getName(item.name)));
                itemsToRemove.push(...items.filter((item, index) => index >= tier));
            } else if (multipleItemsRule === "one") {
                if (!this.actor.items.getName(tierItem.name)) itemsToAdd.push(tierItem);
                itemsToRemove.push(...items.filter((i) => i !== tierItem));
            }
        }
        const removeIds = [];
        const removed = [];
        for (const item of itemsToRemove) {
            const matching = this.actor.items.getName(item.name);
            if (matching) {
                removeIds.push(matching.id);
                removed.push(matching);
            }
        }
        await this.actor.deleteEmbeddedDocuments("Item", removeIds);
        Item.implementation.create(itemsToAdd, { parent: this.actor });
        if (removeIds.length > 0) ui.notifications.info(l(`${MODULE_ID}.skill-tree-actor.removed-items`) + removed.map((i) => i.name).join(", "));
        if (itemsToAdd.length > 0) ui.notifications.info(l(`${MODULE_ID}.skill-tree-actor.added-items`) + itemsToAdd.map((i) => i.name).join(", "));
        if (itemsToAdd.length && !soundPlayed) this.playSound();
    }

    playSound() {
        const sound = this.skillData.sound || this.group?.sound;
        if (sound) foundry.audio.AudioHelper.play({ src: sound, volume: game.settings.get("core", "globalInterfaceVolume"), autoplay: true, loop: false }, false);
    }

    async executeUnlockScript() {
        const { onUnlockScript } = this.skillData;
        if (!onUnlockScript) return;
        const AsyncFunction = async function () {}.constructor;
        const fn = new AsyncFunction("actor", "skill", "group", "skillTree", "skillHelper", onUnlockScript);
        try {
            await fn(this.actor, this.skill, this.group, this.skillTree, this);
        } catch (e) {
            ui.notifications.error("There was an error in your macro syntax. See the console (F12) for details");
            console.error(e);
            return false;
        }
    }
}
