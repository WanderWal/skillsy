import { getSkillPoints, getSkillTreePoints, setSkillPoints, SkillTreeActor, skillTreeMatchesActorRequirements } from "./app/SkillTreeActor.js";
import { SkillTreeApplication } from "./app/SkillTreeApplication.js";
import { SkillTreeManager } from "./app/SkillTreeManager.js";
import { initConfig } from "./config.js";
import { l } from "./lib/utils.js";
import { getSetting, registerSettings } from "./settings.js";

import { MODULE_ID } from "./consts.js";

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
        getSkillTreePoints,
        apps: {
            SkillTreeActor,
            SkillTreeApplication,
            SkillTreeManager,
        },
    };
    module.API = API;

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
