import { MODULE_ID } from "../consts.js";
import { getDerivedSkillPointMap, getPointBuildConfigs } from "../config.js";
import { deepClone, getProperty, HandlebarsApplication, l, mergeClone, mergeObject } from "../lib/utils.js";
import { FormBuilder } from "../lib/formBuilder.js";
import { DEFAULT_SKILL_DATA, SKILL_LINE_WIDTH, SkillTreeApplication, reverseOperators } from "./SkillTreeApplication.js";
import {getSetting, setSetting} from "../settings.js";

let dbOperationsPending = false;
const PLUTONIUM_SUPPRESS_CREATE_SHEET_ITEM_HOOK_KEY = "_isSuppressCreateSheetItemHook";

function normalizeStringList(values) {
    const list = Array.isArray(values) ? values : [values];
    return list
        .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
        .filter((value) => value.length > 0);
}

function getNumeric(value) {
    if (!Number.isFinite(Number(value))) return null;
    return parseInt(value);
}

function normalizeRequiredLevel(value) {
    const parsed = getNumeric(value);
    if (parsed === null) return null;
    return Math.max(0, parsed);
}

function getActorLevel(actor) {
    const directLevel = getNumeric(actor?.system?.details?.level);
    if (directLevel !== null) return Math.max(0, directLevel);

    const valueLevel = getNumeric(actor?.system?.details?.level?.value);
    if (valueLevel !== null) return Math.max(0, valueLevel);

    const classes = actor?.itemTypes?.class ?? actor?.items?.filter((item) => item.type === "class") ?? [];
    const summedClassLevels = classes.reduce((sum, classItem) => {
        const classLevel = getNumeric(classItem?.system?.levels) ?? getNumeric(classItem?.system?.level) ?? 0;
        return sum + Math.max(0, classLevel);
    }, 0);

    return Math.max(0, summedClassLevels);
}

function normalizeUuidList(values) {
    const list = Array.isArray(values) ? values : [];
    return list
        .filter((value) => typeof value === "string" && value.length > 0)
        .filter((value, index, all) => all.indexOf(value) === index);
}

function normalizePlannedSkillEntries(values) {
    const entries = Array.isArray(values) ? values : [];
    const normalized = [];
    for (const entry of entries) {
        if (typeof entry === "string" && entry.length > 0) {
            normalized.push({ uuid: entry });
            continue;
        }
        const uuid = typeof entry?.uuid === "string" ? entry.uuid : "";
        if (!uuid) continue;
        const costValue = Number(entry?.cost);
        const cost = Number.isFinite(costValue) && parseInt(costValue) > 0 ? parseInt(costValue) : undefined;
        normalized.push(cost ? { uuid, cost } : { uuid });
    }
    return normalized.filter((entry, index, all) => all.findIndex((candidate) => candidate.uuid === entry.uuid) === index);
}

function getPlannedBuildSkillRows(build) {
    const plannedSkills = normalizePlannedSkillEntries(build?.plannedSkills);
    const count = plannedSkills.length;
    if (!count) return [];

    const maxPoints = Math.max(0, parseInt(build?.maxPoints ?? 0));
    const rows = plannedSkills.map((entry) => ({ uuid: entry.uuid, maxCost: 1 }));

    if (maxPoints <= count) return rows;

    let remainingBudget = maxPoints - count;
    const autoIndices = [];

    for (const [index, entry] of plannedSkills.entries()) {
        const desiredCost = Number.isFinite(Number(entry.cost)) ? Math.max(1, parseInt(entry.cost)) : null;
        if (!desiredCost) {
            autoIndices.push(index);
            continue;
        }

        const desiredExtra = Math.max(0, desiredCost - 1);
        const appliedExtra = Math.min(desiredExtra, remainingBudget);
        rows[index].maxCost += appliedExtra;
        remainingBudget -= appliedExtra;
    }

    const distributeIndices = autoIndices.length ? autoIndices : rows.map((_, index) => index);
    const baseExtra = Math.floor(remainingBudget / distributeIndices.length);
    const remainder = remainingBudget % distributeIndices.length;

    for (const [index, rowIndex] of distributeIndices.entries()) {
        rows[rowIndex].maxCost += baseExtra + (index < remainder ? 1 : 0);
    }

    return rows;
}

function getConfiguredSkillPointValue(skillUuid, fallback = 1) {
    const page = typeof skillUuid === "string" ? fromUuidSync(skillUuid) : null;
    const configured = Number.isFinite(Number(page?.getFlag(MODULE_ID, "points"))) ? parseInt(page.getFlag(MODULE_ID, "points")) : null;
    if (configured !== null) return Math.max(1, configured);
    return Math.max(1, parseInt(fallback ?? 1));
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
    if (requiredClasses.length) {
        const actorClasses = getActorClassIdentifiers(actor);
        const classRequirementMet = requiredClasses.some((requiredClass) => actorClasses.has(requiredClass));
        if (!classRequirementMet) return false;
    }

    const requiredMinLevel = normalizeRequiredLevel(skillTree.getFlag(MODULE_ID, "requiredMinLevel"));
    const requiredMaxLevel = normalizeRequiredLevel(skillTree.getFlag(MODULE_ID, "requiredMaxLevel"));
    if (requiredMinLevel === null && requiredMaxLevel === null) return true;

    const actorLevel = getActorLevel(actor);
    if (requiredMinLevel !== null && actorLevel < requiredMinLevel) return false;
    if (requiredMaxLevel !== null && actorLevel > requiredMaxLevel) return false;
    return true;
}

function hasPointBuilds() {
    return game.settings.settings.has(`${MODULE_ID}.pointBuilds`);
}

function getActiveBuildId(actor, fallbackBuilds = []) {
    const builds = fallbackBuilds.length ? fallbackBuilds : getPointBuildConfigs();
    const actorBuildId = actor.getFlag(MODULE_ID, "activeBuildId");
    if (builds.some((build) => build.id === actorBuildId)) return actorBuildId;
    return builds[0]?.id;
}

function getBuild(actor, buildId) {
    const builds = getPointBuildConfigs();
    const activeBuildId = buildId ?? getActiveBuildId(actor, builds);
    return builds.find((build) => build.id === activeBuildId) ?? builds[0];
}

function getActorBuildPointAdjustment(actor, buildId) {
    return parseInt(actor.getFlag(MODULE_ID, `buildPointAdjustments.${buildId}`) ?? 0);
}

export function getActorBuildSkills(actor, buildId) {
    const skills = actor.getFlag(MODULE_ID, `buildSkills.${buildId}`) ?? [];
    return Array.isArray(skills) ? foundry.utils.deepClone(skills) : [];
}

function getBuildSkillSpentValue(skill) {
    if (!skill) return 0;
    const configuredCost = getConfiguredSkillPointValue(skill.uuid, skill?.maxCost ?? skill?.points ?? 1);
    const spentPoints = parseInt(skill?.points ?? 0);
    if (configuredCost !== null) return spentPoints > 0 ? configuredCost : 0;
    return Math.max(0, spentPoints);
}

export function getBuildSpentPoints(actor, buildId) {
    return getActorBuildSkills(actor, buildId).reduce((sum, skill) => sum + getBuildSkillSpentValue(skill), 0);
}

export function getBuildMaxPoints(actor, buildId) {
    const build = getBuild(actor, buildId);
    if (!build) return 0;
    return Math.max(0, parseInt(build.maxPoints ?? 0) + getActorBuildPointAdjustment(actor, build.id));
}

export function getSkillPoints(actor, skillTree, options = {}) {
    if (hasPointBuilds()) {
        const build = getBuild(actor, options.buildId);
        if (!build) return 0;
        const spent = getBuildSpentPoints(actor, build.id);
        return getBuildMaxPoints(actor, build.id) - spent;
    }

    const independent = skillTree?.getFlag(MODULE_ID, "independentSkillPoints");
    if (independent) return actor.getFlag(MODULE_ID, `skillTreeSkillPoints.${skillTree.id}`) ?? 0;
    return actor.getFlag(MODULE_ID, "skillPoints") ?? 0;
}

export async function setSkillPoints(actor, skillTree, value, options = {}) {
    value = parseInt(value);

    if (hasPointBuilds()) {
        const build = getBuild(actor, options.buildId);
        if (!build) return;
        const spent = getBuildSpentPoints(actor, build.id);
        const adjustment = value + spent - parseInt(build.maxPoints ?? 0);
        return actor.setFlag(MODULE_ID, `buildPointAdjustments.${build.id}`, adjustment);
    }

    const independent = skillTree?.getFlag(MODULE_ID, "independentSkillPoints");
    if (independent) return actor.setFlag(MODULE_ID, `skillTreeSkillPoints.${skillTree.id}`, value);
    else return actor.setFlag(MODULE_ID, "skillPoints", parseInt(value));
}

export async function ensureActorBuildState(actor) {
    if (!hasPointBuilds()) return;

    const builds = getPointBuildConfigs();
    const derivedPoints = getDerivedSkillPointMap(builds);
    if (!builds.length) return;

    const expectedBuildIds = new Set(builds.map((build) => build.id));
    let activeBuildId = getActiveBuildId(actor, builds);
    let buildSkills = actor.getFlag(MODULE_ID, "buildSkills");
    if (!buildSkills || typeof buildSkills !== "object") buildSkills = {};

    let changed = false;
    if (!activeBuildId) {
        activeBuildId = builds[0].id;
        changed = true;
    }

    for (const build of builds) {
        const currentBuildSkills = Array.isArray(buildSkills[build.id]) ? buildSkills[build.id] : [];
        const plannedRows = getPlannedBuildSkillRows(build);
        if (plannedRows.length) {
            const currentByUuid = new Map(currentBuildSkills.map((skill) => [skill.uuid, skill]));
            const plannedUuids = new Set(plannedRows.map((skill) => skill.uuid));
            const syncedRows = plannedRows.map((plannedSkill) => {
                const existingPoints = parseInt(currentByUuid.get(plannedSkill.uuid)?.points ?? 0);
                const derivedPointValue = derivedPoints.get(plannedSkill.uuid) ?? getConfiguredSkillPointValue(plannedSkill.uuid, plannedSkill.maxCost);
                const points = Math.max(0, Math.min(existingPoints, derivedPointValue));
                return {
                    uuid: plannedSkill.uuid,
                    points,
                    maxCost: derivedPointValue,
                };
            });

            const extraRows = currentBuildSkills
                .filter((skill) => !plannedUuids.has(skill.uuid))
                .map((skill) => {
                    const maxCost = getConfiguredSkillPointValue(skill.uuid, skill?.maxCost ?? skill?.points ?? 1);
                    const points = Math.max(0, Math.min(parseInt(skill?.points ?? 0), maxCost));
                    return {
                        uuid: skill.uuid,
                        points,
                        maxCost,
                    };
                });

            const nextRows = [...syncedRows, ...extraRows];

            const oldSerialized = JSON.stringify(currentBuildSkills);
            const newSerialized = JSON.stringify(nextRows);
            if (oldSerialized !== newSerialized) {
                buildSkills[build.id] = nextRows;
                changed = true;
            }
        } else if (!Array.isArray(buildSkills[build.id])) {
            buildSkills[build.id] = [];
            changed = true;
        }
    }

    const legacySkills = actor.getFlag(MODULE_ID, "skills") ?? [];
    const hasAnyBuildSkills = Object.values(buildSkills).some((skills) => Array.isArray(skills) && skills.length);
    if (!hasAnyBuildSkills && Array.isArray(legacySkills) && legacySkills.length) {
        buildSkills[activeBuildId] = legacySkills.map((skill) => ({
            uuid: skill.uuid,
            points: parseInt(skill.points ?? 0),
            maxCost: Math.max(1, parseInt(skill.maxCost ?? 1)),
        }));
        changed = true;
    }

    const currentAdjustments = actor.getFlag(MODULE_ID, "buildPointAdjustments") ?? {};
    const validAdjustments = {};
    for (const [buildId, value] of Object.entries(currentAdjustments)) {
        if (!expectedBuildIds.has(buildId)) continue;
        validAdjustments[buildId] = parseInt(value ?? 0);
    }

    if (Object.keys(currentAdjustments).length !== Object.keys(validAdjustments).length) changed = true;

    if (changed) {
        await actor.update({
            flags: {
                [MODULE_ID]: {
                    activeBuildId,
                    buildSkills,
                    buildPointAdjustments: validAdjustments,
                },
            },
        });
    }
}

export function getSkillTreePoints(actor, skillTree, options = {}) {
    const build = hasPointBuilds() ? getBuild(actor, options.buildId) : null;
    const actorSkills = build ? getActorBuildSkills(actor, build.id) : (actor.getFlag(MODULE_ID, "skills") ?? []);
    const groups = skillTree.getFlag(MODULE_ID, "groups") ?? [];
    const totalPoints = {

    }
    groups.forEach((group) => {
        totalPoints[group.id] = 0;
    });

    const pages = Array.from(skillTree.pages);
    pages.forEach((page) => {
        const groupId = page.flags[MODULE_ID]?.groupId;
        if (totalPoints[groupId] === undefined) return;
        const actorSkill = actorSkills.find((s) => s.uuid === page.uuid);
        totalPoints[groupId] += build ? getBuildSkillSpentValue(actorSkill) : parseInt(actorSkill?.points ?? 0);
    });

    const totalSkillTreePoints = Object.values(totalPoints).reduce((a, b) => a + b, 0);

    return {...totalPoints, total: totalSkillTreePoints};

}

function getActorSkillRemovalRequests(actor) {
    const requests = actor?.getFlag(MODULE_ID, "skillRemovalRequests") ?? [];
    if (!Array.isArray(requests)) return [];
    return requests;
}

async function setActorSkillRemovalRequests(actor, requests) {
    await actor.setFlag(MODULE_ID, "skillRemovalRequests", requests);
}

async function removeLinkedItemsFromActorForSkill(actor, skillUuid) {
    const skillPage = skillUuid ? await fromUuid(skillUuid) : null;
    if (!skillPage || skillPage.documentName !== "JournalEntryPage") return;

    const skillData = mergeClone(DEFAULT_SKILL_DATA, skillPage.flags[MODULE_ID]);
    const itemUuids = Array.isArray(skillData.itemUuids) ? skillData.itemUuids : [];
    if (!itemUuids.length) return;

    const removeIds = [];
    for (const uuid of itemUuids) {
        const item = await fromUuid(uuid);
        if (!item) continue;
        const matching = actor.items.getName(item.name);
        if (!matching) continue;
        removeIds.push(matching.id);
    }

    if (removeIds.length) await actor.deleteEmbeddedDocuments("Item", removeIds);
}

async function approveSkillRemovalRequest(actor, request) {
    const skillUuid = request?.skillUuid;
    if (!skillUuid) return false;

    const buildId = request?.buildId;
    const actorBuildSkills = actor.getFlag(MODULE_ID, "buildSkills") ?? {};
    if (buildId && typeof actorBuildSkills === "object") {
        const currentBuildSkills = Array.isArray(actorBuildSkills[buildId]) ? foundry.utils.deepClone(actorBuildSkills[buildId]) : [];
        const updatedBuildSkills = currentBuildSkills.map((skill) => {
            if (skill.uuid !== skillUuid) return skill;
            return { ...skill, points: 0 };
        });
        if (JSON.stringify(currentBuildSkills) !== JSON.stringify(updatedBuildSkills)) {
            await actor.setFlag(MODULE_ID, `buildSkills.${buildId}`, updatedBuildSkills);
        }
    }

    const legacySkills = actor.getFlag(MODULE_ID, "skills") ?? [];
    if (Array.isArray(legacySkills) && legacySkills.length) {
        const updatedLegacySkills = legacySkills.map((skill) => {
            if (skill.uuid !== skillUuid) return skill;
            return { ...skill, points: 0 };
        });
        if (JSON.stringify(legacySkills) !== JSON.stringify(updatedLegacySkills)) {
            await actor.setFlag(MODULE_ID, "skills", updatedLegacySkills);
        }
    }

    await removeLinkedItemsFromActorForSkill(actor, skillUuid);
    return true;
}

export async function requestSkillRemoval(actor, data = {}) {
    if (!actor) return { ok: false, reason: "missing-actor" };

    const skillUuid = typeof data.skillUuid === "string" ? data.skillUuid : "";
    if (!skillUuid) return { ok: false, reason: "missing-skill" };

    const buildId = typeof data.buildId === "string" ? data.buildId : "";
    const requests = getActorSkillRemovalRequests(actor);
    const existingPending = requests.find((request) => request?.status === "pending" && request?.skillUuid === skillUuid && (request?.buildId ?? "") === buildId);
    if (existingPending) return { ok: false, reason: "duplicate" };

    const request = {
        id: foundry.utils.randomID(),
        status: "pending",
        skillUuid,
        buildId,
        skillName: data.skillName ?? "",
        requestedByUserId: game.user.id,
        requestedByUserName: game.user.name,
        requestedAt: new Date().toISOString(),
    };

    requests.push(request);
    await setActorSkillRemovalRequests(actor, requests);
    return { ok: true, request };
}

export async function resolveSkillRemovalRequest(actor, requestId, { approve = false } = {}) {
    if (!game.user.isGM) return { ok: false, reason: "not-gm" };
    if (!actor || !requestId) return { ok: false, reason: "invalid" };

    const requests = getActorSkillRemovalRequests(actor);
    const request = requests.find((entry) => entry?.id === requestId && entry?.status === "pending");
    if (!request) return { ok: false, reason: "missing-request" };

    if (approve) await approveSkillRemovalRequest(actor, request);

    const remaining = requests.filter((entry) => entry?.id !== requestId);
    await setActorSkillRemovalRequests(actor, remaining);
    return { ok: true, approved: approve };
}

export class SkillTreeActor extends HandlebarsApplication {
    constructor(actor, options = {}) {
        super();
        const { registerHooks = true, onRequestRender } = options;
        this.actor = typeof actor === "string" ? fromUuidSync(actor) : actor;
        this._onRequestRender = typeof onRequestRender === "function" ? onRequestRender : null;
        this.skills = new Map();
        if (registerHooks) {
            this.hookId = Hooks.on("updateJournalEntry", (document, update) => {
                if (document === this.skillTree) this.requestRender();
            });
            this.pageHookId = Hooks.on("updateJournalEntryPage", (document, update) => {
                if (document.parent === this.skillTree) this.requestRender();
            });
            this.actorHookId = Hooks.on("updateActor", (document, update) => {
                if (document === this.actor) this.requestRender();
            });
        }
    }

    requestRender() {
        if (this._onRequestRender) return this._onRequestRender();
        return this.render(true);
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
        await ensureActorBuildState(this.actor);

        const skillTrees = game.journal
            .filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
            .sort((a, b) => a.sort - b.sort)
            .filter((j) => j.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER))
            .filter((j) => skillTreeMatchesActorRequirements(j, this.actor));

        const selectedSkillTreeUuid = this.actor.getFlag(MODULE_ID, "selectedSkillTree");
        const selectedSkillTree = selectedSkillTreeUuid ? await fromUuid(selectedSkillTreeUuid) : null;
        this.skillTree = selectedSkillTree && skillTrees.some((tree) => tree.uuid === selectedSkillTree.uuid) ? selectedSkillTree : skillTrees[0];

        if (!this.skillTree) return {};

        const pointBuilds = getPointBuildConfigs();
        this.activeBuildId = getActiveBuildId(this.actor, pointBuilds);

        const groups = foundry.utils.deepClone(this.skillTree.getFlag(MODULE_ID, "groups") ?? []);
        //gridTemplate
        const pages = Array.from(this.skillTree.pages);

        this.skills = new Map();
        const promises = [];
        pages.forEach((page) => {
            const skill = new Skill(page, this.actor, this.skills, this.activeBuildId);
            this.skills.set(page.uuid, skill);
            promises.push(skill.computeCanBeUnlocked());
        });

        await Promise.all(promises);

        const totalPoints = getSkillTreePoints(this.actor, this.skillTree, { buildId: this.activeBuildId });

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
                        const requiresLessPointsInGroup = skillHelper.requiresLessPointsInGroup;
                        if (requiresMorePointsInGroup) requirements += (`<span class="requirement">${skillHelper.group.name} &ge; ${requiresMorePointsInGroup}</span>`);
                        if (requiresLessPointsInGroup) requirements += (`<span class="requirement">${skillHelper.group.name} &le; ${requiresLessPointsInGroup}</span>`);
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

        const skillPoints = getSkillPoints(this.actor, this.skillTree, { buildId: this.activeBuildId });

        const skillStyle = this.skillTree.getFlag(MODULE_ID, "skillStyle") ?? Object.keys(SkillTreeApplication.SKILL_STYLE)[0];

        const pointsImage = this.skillTree.getFlag(MODULE_ID, "pointsImage");

        return {
            groups,
            skillTreesOptions,
            skillPoints,
            skillTreeName: this.skillTree.name,
            useCircleStyle: skillStyle === "circle",
            pointsImage,
            skillTreePoints: totalPoints.total,
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.activateContent(this.element);
    }

    activateContent(html) {
        if (!html) return;

        const selector = html.querySelector(".skill-tree-selector");
        const menuToggle = html.querySelector("button[name='toggle-skill-tree-menu']");
        const menu = html.querySelector(".skill-tree-menu");

        const closeSkillTreeMenu = () => {
            if (!menu || !menuToggle) return;
            menu.classList.remove("open");
            menuToggle.setAttribute("aria-expanded", "false");
        };

        if (menuToggle && menu) {
            menuToggle.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const isOpen = menu.classList.toggle("open");
                menuToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
            });

            html.querySelectorAll("button[name='select-skill-tree']").forEach((button) => {
                button.addEventListener("click", async (event) => {
                    event.preventDefault();
                    const selectedUuid = event.currentTarget.dataset.value;
                    if (!selectedUuid || selectedUuid === this.skillTree?.uuid) {
                        closeSkillTreeMenu();
                        return;
                    }
                    await this.actor.setFlag(MODULE_ID, "selectedSkillTree", selectedUuid);
                    this.requestRender();
                });
            });

            html.addEventListener("click", (event) => {
                if (!selector?.contains(event.target)) closeSkillTreeMenu();
            });
        }

        html.querySelectorAll(".skill-container").forEach((skillContainer) => {
            skillContainer.addEventListener("contextmenu", async (event) => {
                event.preventDefault();
                if (dbOperationsPending) return;
                const skillUuid = skillContainer.dataset.uuid;
                const skill = this.skills.get(skillUuid);
                if (!skill.points.value) return;

                if (!game.user.isGM && getSetting("playersCantRemovePoints") && getSetting("playersRequestSkillRemoval")) {
                    dbOperationsPending = true;
                    const requestResult = await requestSkillRemoval(this.actor, {
                        skillUuid,
                        buildId: this.activeBuildId,
                        skillName: skill.skill?.name ?? "",
                    });
                    if (requestResult.ok) ui.notifications.info(l(`${MODULE_ID}.skill-tree-actor.removal-request-created`));
                    else if (requestResult.reason === "duplicate") ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.removal-request-duplicate`));
                    dbOperationsPending = false;
                    this.requestRender();
                    return;
                }

                dbOperationsPending = true;
                await skill.modifyPoints(-1);
                dbOperationsPending = false;
                this.requestRender();
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
                this.requestRender();
            });
        });

        this.drawLinks(html);
    }

    getSkillRect(skillUuid, root = this.element) {
        if (!root) return null;
        const el = root.querySelector(`.skill-container[data-uuid="${skillUuid}"]`);
        if (!el) return null;
        return el.getBoundingClientRect();
    }

    async drawLinks(root = this.element) {
        if (!this.skillTree) return;
        if (!root) return;
        const groups = this.skillTree.getFlag(MODULE_ID, "groups") ?? [];
        const pages = Array.from(this.skillTree.pages);
        const rectCache = {};
        for (const group of groups) {
            const skills = pages.filter((p) => p.getFlag(MODULE_ID, "groupId") === group.id);
            const element = root.querySelector(`.skill-group[data-group-id="${group.id}"]`);
            if (!element) continue;

            //Draw lines between linked skills
            const svgCanvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svgCanvas.setAttribute("width", "100%");
            svgCanvas.setAttribute("height", "100%");
            const bounding = element.getBoundingClientRect();
            const elementRect = { x: bounding.x + 4, y: bounding.y + 4, width: bounding.width - 8, height: bounding.height - 8 };
            svgCanvas.setAttribute("viewBox", `0 0 ${elementRect.width} ${elementRect.height}`);
            element.appendChild(svgCanvas);
            for (const skill of skills) {
                const skillRect = rectCache[skill.uuid] ?? this.getSkillRect(skill.uuid, root);
                if (skillRect) rectCache[skill.uuid] = skillRect;
                const linked = skill.getFlag(MODULE_ID, "connectedSkills") ?? [];
                for (const linkedSkill of linked) {
                    try {
                        const linkedSkillRect = rectCache[linkedSkill] ?? this.getSkillRect(linkedSkill, root);
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
        if (this.hookId) Hooks.off("updateJournalEntry", this.hookId);
        if (this.pageHookId) Hooks.off("updateJournalEntryPage", this.pageHookId);
        if (this.actorHookId) Hooks.off("updateActor", this.actorHookId);
    }

    toggleFullscreen(toggle) {
        this.element.classList.toggle("fullscreen", toggle);
    }
}

class Skill {
    constructor(skill, actor, allSkills, buildId) {
        this.allSkills = allSkills;
        this.skill = skill;
        this.skillTree = skill.parent;
        this.actor = actor;
        this.buildId = buildId;
        this.actorSkills = getActorBuildSkills(this.actor, this.buildId);
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

    get buildSkillEntry() {
        return this.actorSkills.find((s) => s.uuid === this.skill.uuid);
    }

    get purchaseCost() {
        return getConfiguredSkillPointValue(this.skill.uuid, this.buildSkillEntry?.maxCost ?? 1);
    }

    get usesBuildCost() {
        return !!this.buildSkillEntry;
    }

    get nodeBadgeText() {
        return `${this.points.max}`;
    }

    get nodeBadgeTitle() {
        return `${l(`${MODULE_ID}.skill-tree-actor.cost`)} ${this.points.max}`;
    }

    get showNodeBadge() {
        return true;
    }

    get pointsInGroup() {
        const skillTreePoints = getSkillTreePoints(this.actor, this.skillTree, { buildId: this.buildId });
        const pointsInGroup = skillTreePoints[this.group?.id] ?? 0;
        return pointsInGroup;
    }

    get requiresMorePointsInGroup() {
        const minimumPointsInGroup = parseInt(this.skillData.minimumPointsInGroup || 0);
        return minimumPointsInGroup > 0 && this.pointsInGroup < minimumPointsInGroup ? minimumPointsInGroup : false;
    }

    get requiresLessPointsInGroup() {
        const maximumPointsInGroup = parseInt(this.skillData.maximumPointsInGroup || 0);
        return maximumPointsInGroup > 0 && this.pointsInGroup + this.purchaseCost > maximumPointsInGroup ? maximumPointsInGroup : false;
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

        const maximumPointsInGroup = parseInt(this.skillData.maximumPointsInGroup || 0);
        if (maximumPointsInGroup > 0 && this.pointsInGroup + this.purchaseCost > maximumPointsInGroup) {
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
        const value = parseInt(this.buildSkillEntry?.points ?? 0);
        const maxBySkill = getConfiguredSkillPointValue(this.skill.uuid, this.skill.getFlag(MODULE_ID, "points") ?? 1);
        const max = Math.max(1, maxBySkill);
        return { value, max };
    }

    get showPointsCount() {
        return !this.usesBuildCost && this.points.max > 1;
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
        if (hasPointBuilds()) {
            return this.modifyBuildPurchase(modifyValue);
        }

        const wasUnlocked = this.isUnlocked;
        const { value, max } = this.points;
        const currentSkill = this.buildSkillEntry ?? { uuid: this.skill.uuid, points: 0, maxCost: max };
        const newPoints = value + modifyValue;
        const newActorPoints = parseInt(getSkillPoints(this.actor, this.skillTree, { buildId: this.buildId })) - modifyValue;
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
        await this.actor.setFlag(MODULE_ID, `buildSkills.${this.buildId}`, this.actorSkills);
        if (!wasUnlocked && this.isUnlocked) this.playSound();
        await this.updateItems({soundPlayed: !wasUnlocked && this.isUnlocked});
        await this.executeUnlockScript();
        return true;
    }

    async modifyBuildPurchase(modifyValue) {
        const wasUnlocked = this.isUnlocked;
        const { value, max } = this.points;
        const purchaseCost = this.purchaseCost;
        const currentSkill = this.buildSkillEntry ?? { uuid: this.skill.uuid, points: 0, maxCost: purchaseCost };

        if (modifyValue > 0) {
            if (value > 0) return false;
            const remainingPoints = parseInt(getSkillPoints(this.actor, this.skillTree, { buildId: this.buildId }));
            if (remainingPoints < purchaseCost) return false;
            currentSkill.points = max;
        } else if (modifyValue < 0) {
            if (value <= 0) return false;
            const newPoints = 0;
            const skipRemovalCheck = false;
            if (!skipRemovalCheck) {
                const allowIncompleteProgression = this.skillData.allowIncompleteProgression || 0;
                const allowRemovalDueToIncompleteProgression = allowIncompleteProgression && newPoints >= allowIncompleteProgression;
                const skillsThatRequireThisSkill = Array.from(this.allSkills)
                    .map((s) => s[1])
                    .filter((s) => s.skillData.connectedSkills.includes(this.skill.uuid));
                if (!allowRemovalDueToIncompleteProgression && skillsThatRequireThisSkill.length > 0 && skillsThatRequireThisSkill.some((s) => s.isUnlocked)) return false;
            }
            currentSkill.points = 0;
        } else {
            return false;
        }

        this.actorSkills = this.actorSkills.filter((s) => s.uuid !== this.skill.uuid);
        this.actorSkills.push(currentSkill);
        await this.actor.setFlag(MODULE_ID, `buildSkills.${this.buildId}`, this.actorSkills);
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
        const current = (this.actorSkills ?? []).find((s) => s.uuid === this.skill.uuid)?.points ?? 0;
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
        let createdItems = [];
        if (itemsToAdd.length) {
            createdItems = await this.createItemsViaActorDrop(itemsToAdd);
            if (!createdItems.length) {
                const createData = itemsToAdd.map((item) => item.toObject());
                createdItems = await this.actor.createEmbeddedDocuments("Item", createData);
            }
        }
        if (removeIds.length > 0) ui.notifications.info(l(`${MODULE_ID}.skill-tree-actor.removed-items`) + removed.map((i) => i.name).join(", "));
        if (itemsToAdd.length > 0) ui.notifications.info(l(`${MODULE_ID}.skill-tree-actor.added-items`) + itemsToAdd.map((i) => i.name).join(", "));
        if (itemsToAdd.length && !soundPlayed) this.playSound();
    }

    async createItemsViaActorDrop(itemsToAdd = []) {
        if (game.system?.id !== "dnd5e") return [];
        const sheet = this.actor?.sheet;
        const dropRoot = sheet?._onDrop;
        const dropItem = sheet?._onDropItem;
        const dropCreate = sheet?._onDropItemCreate;
        if (typeof dropRoot !== "function" && typeof dropItem !== "function" && typeof dropCreate !== "function") return [];

        const createdItems = [];
        const knownIds = new Set(Array.from(this.actor.items ?? []).map((item) => item.id));

        for (const sourceItem of itemsToAdd) {
            const dropPayload = typeof sourceItem.toDragData === "function"
                ? sourceItem.toDragData()
                : {
                    type: "Item",
                    uuid: sourceItem.uuid,
                    id: sourceItem.id,
                    documentName: sourceItem.documentName,
                };

            dropPayload.type ??= "Item";
            dropPayload.uuid ??= sourceItem.uuid;
            dropPayload.id ??= sourceItem.id;
            dropPayload.documentName ??= sourceItem.documentName ?? "Item";
            if (sourceItem.pack) dropPayload.pack ??= sourceItem.pack;
            if (game.modules.get("plutonium")?.active) {
                dropPayload[PLUTONIUM_SUPPRESS_CREATE_SHEET_ITEM_HOOK_KEY] = true;
            }

            const serializedPayload = JSON.stringify(dropPayload);
            const dataTransfer = {
                dropEffect: "copy",
                effectAllowed: "copy",
                files: [],
                items: [],
                types: ["text/plain", "text", "application/json"],
                getData: (format) => {
                    if (["text/plain", "text", "application/json"].includes(format)) return serializedPayload;
                    return "";
                },
                setData() {},
                clearData() {},
            };

            const fakeEvent = {
                preventDefault() {},
                stopPropagation() {},
                stopImmediatePropagation() {},
                dataTransfer,
                target: sheet?.element,
                currentTarget: sheet?.element,
                srcElement: sheet?.element,
                view: window,
            };

            let result = null;
            if (typeof dropRoot === "function") {
                try {
                    result = await dropRoot.call(sheet, fakeEvent);
                } catch (e) {
                    result = null;
                }
            }

            if (result === null && typeof dropItem === "function") {
                try {
                    result = await dropItem.call(sheet, fakeEvent, dropPayload);
                } catch (e) {
                    result = null;
                }
            }

            if (result === null && typeof dropCreate === "function") {
                const itemData = sourceItem.toObject();
                if (!itemData.flags) itemData.flags = {};
                if (!itemData.flags.core) itemData.flags.core = {};
                if (!itemData.flags.core.sourceId) itemData.flags.core.sourceId = sourceItem.uuid;
                try {
                    result = await dropCreate.call(sheet, itemData);
                } catch (e) {
                    result = null;
                }
            }

            if (Array.isArray(result)) {
                for (const created of result) {
                    if (created?.documentName !== "Item") continue;
                    if (knownIds.has(created.id)) continue;
                    knownIds.add(created.id);
                    createdItems.push(created);
                }
            } else if (result?.documentName === "Item") {
                if (!knownIds.has(result.id)) {
                    knownIds.add(result.id);
                    createdItems.push(result);
                }
            }

            const freshItems = Array.from(this.actor.items ?? []).filter((item) => !knownIds.has(item.id));
            for (const freshItem of freshItems) {
                knownIds.add(freshItem.id);
                createdItems.push(freshItem);
            }
        }

        return createdItems;
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
