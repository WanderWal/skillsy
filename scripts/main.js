import { getSkillPoints, getSkillTreePoints, setSkillPoints, SkillTreeActor, skillTreeMatchesActorRequirements } from "./app/SkillTreeActor.js";
import { SkillTreeApplication } from "./app/SkillTreeApplication.js";
import { SkillTreeManager } from "./app/SkillTreeManager.js";
import { getPointBuildConfigs, initConfig } from "./config.js";
import { l } from "./lib/utils.js";
import { getSetting, registerSettings } from "./settings.js";

import { MODULE_ID } from "./consts.js";

function getNumeric(value) {
    if (!Number.isFinite(Number(value))) return null;
    return parseInt(value);
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

Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
    if (!app.object.hasPlayerOwner && getSetting("playerOwnedOnly")) return;
    if (app.object.isOwner) {
        const skillTrees = game.journal
            .filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
            .filter((j) => j.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER))
            .filter((j) => skillTreeMatchesActorRequirements(j, app.object));
        const selectedSkillTree = app.object.getFlag(MODULE_ID, "selectedSkillTree") ?? skillTrees[0]?.uuid;


        buttons.unshift({
            label: `${MODULE_ID}.header-button.label`,
            class: "skill-tree-header-button",
            icon: "fas fa-code-branch",
            onclick: () => {
                if (!selectedSkillTree) return ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-trees`));
                const skillTree = fromUuidSync(selectedSkillTree) ?? skillTrees[0];
                if (!skillTree) return ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                new SkillTreeActor(app.object).render(true);
            },
        });
    }
});

Hooks.on("getHeaderControlsActorSheetV2", (app, buttons) => {
    if (!app.document.hasPlayerOwner && getSetting("playerOwnedOnly")) return;
    if (app.document.isOwner) {
        const skillTrees = game.journal
            .filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
            .filter((j) => j.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER))
            .filter((j) => skillTreeMatchesActorRequirements(j, app.document));
        const selectedSkillTree = app.document.getFlag(MODULE_ID, "selectedSkillTree") ?? skillTrees[0]?.uuid;


        buttons.push({
            label: `${MODULE_ID}.header-button.label`,
            class: "skill-tree-header-button",
            icon: "fas fa-code-branch",
            onClick: () => {
                if (!selectedSkillTree) return ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-trees`));
                const skillTree = fromUuidSync(selectedSkillTree) ?? skillTrees[0];
                if (!skillTree) return ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-tree`));
                new SkillTreeActor(app.document).render(true);
            },
        });
    }
});
