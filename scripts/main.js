import { getSkillPoints, getSkillTreePoints, setSkillPoints, SkillTreeActor, skillTreeMatchesActorRequirements } from "./app/SkillTreeActor.js";
import { SkillTreeApplication } from "./app/SkillTreeApplication.js";
import { SkillTreeManager } from "./app/SkillTreeManager.js";
import { getPointBuildConfigs, initConfig } from "./config.js";
import { l } from "./lib/utils.js";
import { getSetting, registerSettings } from "./settings.js";

import { MODULE_ID } from "./consts.js";

const SKILL_TREE_SHEET_TAB = "skill-tree";
const skillTreeActiveActorUuids = new Set();

function getNumeric(value) {
    if (!Number.isFinite(Number(value))) return null;
    return parseInt(value);
}

function parseSkillPointsLevelTable(rawTable) {
    const table = new Map();
    if (typeof rawTable !== "string" || !rawTable.trim().length) return table;

    const chunks = rawTable
        .split(/[,\n;]/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);

    for (const chunk of chunks) {
        const match = chunk.match(/^(\d+)\s*[:=]\s*([+-]?\d+)$/);
        if (!match) continue;
        const level = parseInt(match[1]);
        const token = match[2];
        const amount = parseInt(token);
        if (!Number.isFinite(level) || level < 1) continue;
        if (!Number.isFinite(amount)) continue;

        table.set(level, {
            relative: token.startsWith("+") || token.startsWith("-"),
            amount,
        });
    }

    return table;
}

function getSkillPointsFromLevelTable(level, table) {
    let total = 0;
    for (let currentLevel = 1; currentLevel <= Math.max(0, level); currentLevel++) {
        const row = table.get(currentLevel);
        if (!row) continue;
        if (row.relative) total += row.amount;
        else total = row.amount;
    }
    return Math.max(0, total);
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

function getTargetSkillPointsForLevel(level) {
    const levelTableRaw = getSetting("skillPointsLevelTable");
    const levelTable = parseSkillPointsLevelTable(levelTableRaw);
    if (levelTable.size) return getSkillPointsFromLevelTable(level, levelTable);

    const pointsPerLevel = getNumeric(getSetting("skillPointsPerLevel")) ?? 0;
    const flatBonus = getNumeric(getSetting("skillPointsFlatBonus")) ?? 0;
    return Math.max(0, flatBonus + Math.max(0, level) * pointsPerLevel);
}

async function syncActorSkillPointsByLevel(actor, options = {}) {
    const { ignoreSetting = false } = options;
    if (!actor) return;
    if (!game.user.isGM) return;
    if (!ignoreSetting && !getSetting("autoSkillPointsByLevel")) return;

    const level = getActorLevel(actor);
    const targetSkillPoints = getTargetSkillPointsForLevel(level);
    const pointBuilds = getPointBuildConfigs();

    if (pointBuilds.length) {
        const adjustmentUpdates = {};
        for (const build of pointBuilds) {
            const buildMaxPoints = getNumeric(build?.maxPoints) ?? 0;
            const desiredAdjustment = targetSkillPoints - buildMaxPoints;
            const currentAdjustment = getNumeric(actor.getFlag(MODULE_ID, `buildPointAdjustments.${build.id}`)) ?? 0;
            if (desiredAdjustment === currentAdjustment) continue;
            adjustmentUpdates[`flags.${MODULE_ID}.buildPointAdjustments.${build.id}`] = desiredAdjustment;
        }

        if (Object.keys(adjustmentUpdates).length) {
            await actor.update(adjustmentUpdates);
            return true;
        }
        return false;
    }

    const current = getNumeric(actor.getFlag(MODULE_ID, "skillPoints")) ?? 0;
    if (current !== targetSkillPoints) {
        await setSkillPoints(actor, null, targetSkillPoints);
        return true;
    }

    return false;
}

async function resyncAllActorsSkillPointsByLevel(options = {}) {
    const { ignoreSetting = true } = options;
    if (!game.user.isGM) return { processed: 0, updated: 0 };

    let processed = 0;
    let updated = 0;
    for (const actor of game.actors ?? []) {
        processed += 1;
        const didUpdate = await syncActorSkillPointsByLevel(actor, { ignoreSetting });
        if (didUpdate) updated += 1;
    }

    return { processed, updated };
}

Hooks.on("init", () => {
    initConfig();
    registerSettings();
});

Hooks.on("ready", () => {
    const module = game.modules.get(MODULE_ID);
    const API = {
        grantSkillPoints: async (actor, points, options = {}) => {
            const current = getSkillPoints(actor, options.skillTree, { buildId: options.buildId });
            const newPoints = current + points;
            await setSkillPoints(actor, options.skillTree, newPoints, { buildId: options.buildId });
            return newPoints;
        },
        resyncAllActorsSkillPoints: async (options = {}) => {
            return await resyncAllActorsSkillPointsByLevel(options);
        },
        getSkillTreePoints,
        apps: {
            SkillTreeActor,
            SkillTreeApplication,
            SkillTreeManager,
        },
    };
    module.API = API;

    resyncAllActorsSkillPointsByLevel({ ignoreSetting: false });

    if (!game.user.isGM) return;

    Hooks.on("getHeaderControlsJournalSheetV2", (app, buttons) => {
        const isSkillTree = app.document.getFlag(MODULE_ID, "isSkillTree");
        if (!isSkillTree) return;
        buttons.push({
            label: `${MODULE_ID}.header-button.label`,
            class: "skill-tree-header-button",
            icon: "fas fa-code-branch",
            onClick: () => {
                new SkillTreeApplication(app.document).render(true);
            },
        });
    });
});

Hooks.on("updateActor", (actor, update) => {
    if (!getSetting("autoSkillPointsByLevel")) return;

    const levelChanged = foundry.utils.hasProperty(update, "system.details.level")
        || foundry.utils.hasProperty(update, "system.details.level.value");

    if (!levelChanged) return;
    syncActorSkillPointsByLevel(actor);
});

Hooks.on("updateItem", (item) => {
    if (!getSetting("autoSkillPointsByLevel")) return;
    if (item.type !== "class") return;
    if (!item.actor) return;
    syncActorSkillPointsByLevel(item.actor);
});

Hooks.on("createActor", (actor) => {
    if (actor.type !== "character") return;
    if (!getSetting("autoSkillPointsByLevel")) return;
    void syncActorSkillPointsByLevel(actor);
});

function getActorFromSheetApp(app) {
    return app?.actor ?? app?.document ?? app?.object ?? null;
}

function canRenderSkillTreeTab(actor) {
    if (!actor) return false;
    if (actor.type !== "character") return false;
    if (!actor.isOwner) return false;
    if (!actor.hasPlayerOwner && getSetting("playerOwnedOnly")) return false;
    return true;
}

function getSheetRootElement(rendered) {
    if (!rendered) return null;
    if (rendered instanceof HTMLElement) return rendered;
    if (rendered[0] instanceof HTMLElement) return rendered[0];
    return null;
}

function getPrimaryTabGroup(root) {
    const firstTab = root?.querySelector(".tab[data-group][data-tab]");
    if (!firstTab) return "primary";
    return firstTab.dataset.group ?? "primary";
}

function getNavigationElement(root) {
    return root.querySelector("nav.sheet-navigation.tabs, nav.tabs")
        ?? root.querySelector(".tabs[data-group]")?.closest("nav")
        ?? null;
}

async function renderSkillTreeTabContent(actor, tabPanel) {
    if (!tabPanel) return;
    tabPanel.dataset.loading = "true";

    const content = tabPanel.querySelector(".skill-tree-sheet-tab-content");
    if (!content) {
        tabPanel.dataset.loading = "false";
        return;
    }

    const app = new SkillTreeActor(actor, {
        registerHooks: false,
        onRequestRender: async () => {
            await renderSkillTreeTabContent(actor, tabPanel);
        },
    });

    try {
        const context = await app._prepareContext({});
        if (!app.skillTree) {
            content.innerHTML = `<p>${l(`${MODULE_ID}.skill-tree-actor.no-skill-trees`)}</p>`;
            return;
        }

        content.innerHTML = await renderTemplate(SkillTreeActor.PARTS.content.template, context);
        app.activateContent(content);
    } finally {
        tabPanel.dataset.loading = "false";
    }
}

function activateSheetTab(root, tabName, tabGroup) {
    root.querySelectorAll(`[data-group="${tabGroup}"][data-tab]`).forEach((item) => {
        const isActive = item.dataset.tab === tabName;
        item.classList.toggle("active", isActive);
    });
}

async function injectSkillTreeTab(app, rendered) {
    const actor = getActorFromSheetApp(app);
    if (!canRenderSkillTreeTab(actor)) return;

    const root = getSheetRootElement(rendered);
    if (!root) return;

    const nav = getNavigationElement(root);
    if (!nav) return;

    const tabGroup = getPrimaryTabGroup(root);
    const matchingButtons = Array.from(nav.querySelectorAll(`[data-group="${tabGroup}"][data-tab="${SKILL_TREE_SHEET_TAB}"]`));
    const matchingPanels = Array.from(root.querySelectorAll(`.tab[data-group="${tabGroup}"][data-tab="${SKILL_TREE_SHEET_TAB}"]`));

    const navItem = matchingButtons.shift() ?? null;
    if (matchingButtons.length) matchingButtons.forEach((button) => button.remove());

    const tabPanel = matchingPanels.shift() ?? null;
    if (matchingPanels.length) matchingPanels.forEach((panel) => panel.remove());

    const existingPanel = root.querySelector(`.tab[data-group="${tabGroup}"][data-tab]`);
    if (!existingPanel?.parentElement) return;

    let ensuredNavItem = navItem;
    if (!ensuredNavItem) {
        const firstNavItem = nav.querySelector(`[data-group="${tabGroup}"][data-tab]`) ?? nav.querySelector("[data-tab]");
        ensuredNavItem = document.createElement("button");
        ensuredNavItem.className = firstNavItem?.className ?? "item";
        ensuredNavItem.classList.remove("active");
        ensuredNavItem.dataset.tab = SKILL_TREE_SHEET_TAB;
        ensuredNavItem.dataset.group = tabGroup;
        ensuredNavItem.type = "button";
        ensuredNavItem.title = l(`${MODULE_ID}.header-button.label`);
        ensuredNavItem.setAttribute("aria-label", l(`${MODULE_ID}.header-button.label`));
        ensuredNavItem.innerHTML = `<i class="fas fa-code-branch"></i>`;
        nav.appendChild(ensuredNavItem);
    }

    let ensuredTabPanel = tabPanel;
    if (!ensuredTabPanel) {
        const panelTag = existingPanel.tagName.toLowerCase();
        ensuredTabPanel = document.createElement(panelTag);
        ensuredTabPanel.className = "tab skill-tree-sheet-tab";
        ensuredTabPanel.dataset.tab = SKILL_TREE_SHEET_TAB;
        ensuredTabPanel.dataset.group = tabGroup;
        ensuredTabPanel.innerHTML = `<div class="skill-tree-actor skill-tree-sheet-tab-content"></div>`;
        existingPanel.parentElement.appendChild(ensuredTabPanel);
    }

    if (!skillTreeActiveActorUuids.has(actor.uuid)) {
        ensuredNavItem.classList.remove("active");
        ensuredTabPanel.classList.remove("active");
    }

    if (!nav.dataset.skillTreeTabTrackerBound) {
        nav.addEventListener("click", (event) => {
            const clickedTab = event.target?.closest?.(`[data-group="${tabGroup}"][data-tab]`);
            if (!clickedTab) return;
            const clickedTabName = clickedTab.dataset.tab;
            if (clickedTabName) activateSheetTab(root, clickedTabName, tabGroup);
            if (clickedTab.dataset.tab === SKILL_TREE_SHEET_TAB) skillTreeActiveActorUuids.add(actor.uuid);
            else skillTreeActiveActorUuids.delete(actor.uuid);
        });
        nav.dataset.skillTreeTabTrackerBound = "true";
    }

    if (!ensuredNavItem.dataset.skillTreeBound) {
        ensuredNavItem.addEventListener("click", async (event) => {
            event.preventDefault();
            skillTreeActiveActorUuids.add(actor.uuid);
            activateSheetTab(root, SKILL_TREE_SHEET_TAB, tabGroup);
            if (ensuredTabPanel.dataset.loading === "true") return;
            await renderSkillTreeTabContent(actor, ensuredTabPanel);
        });
        ensuredNavItem.dataset.skillTreeBound = "true";
    }

    if (skillTreeActiveActorUuids.has(actor.uuid)) {
        activateSheetTab(root, SKILL_TREE_SHEET_TAB, tabGroup);
        if (ensuredTabPanel.dataset.loading !== "true") await renderSkillTreeTabContent(actor, ensuredTabPanel);
    }
}

Hooks.on("renderActorSheet", (app, html) => {
    injectSkillTreeTab(app, html);
});

Hooks.on("renderActorSheetV2", (app, element) => {
    injectSkillTreeTab(app, element);
});

Hooks.on("renderActorSheet5eCharacter", (app, html) => {
    injectSkillTreeTab(app, html);
});

Hooks.on("renderActorSheet5eCharacter2", (app, element) => {
    injectSkillTreeTab(app, element);
});
