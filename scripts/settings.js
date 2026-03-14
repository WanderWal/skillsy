import {SkillTreeActor} from "./app/SkillTreeActor.js";
import {SkillTreeManager} from "./app/SkillTreeManager.js";
import { SkillPointsLevelTableConfig } from "./app/SkillPointsLevelTableConfig.js";
import {MODULE_ID} from "./consts.js";

const SETTING_CACHE = {};
const DEFAULT_CACHE = false;

export function registerSettings() {
    const settings = {
        playerOwnedOnly: {
            name: `${MODULE_ID}.settings.playerOwnedOnly.name`,
            hint: `${MODULE_ID}.settings.playerOwnedOnly.hint`,
            scope: "world",
            config: true,
            default: false,
            type: Boolean,
        },
        playersCantEditPoints: {
            name: `${MODULE_ID}.settings.playersCantEditPoints.name`,
            hint: `${MODULE_ID}.settings.playersCantEditPoints.hint`,
            scope: "world",
            config: true,
            default: false,
            type: Boolean,
        },
        playersCantRemovePoints: {
            name: `${MODULE_ID}.settings.playersCantRemovePoints.name`,
            hint: `${MODULE_ID}.settings.playersCantRemovePoints.hint`,
            scope: "world",
            config: true,
            default: false,
            type: Boolean,
        },
        autoSkillPointsByLevel: {
            name: `${MODULE_ID}.settings.autoSkillPointsByLevel.name`,
            hint: `${MODULE_ID}.settings.autoSkillPointsByLevel.hint`,
            scope: "world",
            config: true,
            default: false,
            type: Boolean,
        },
        skillPointsLevelTable: {
            name: `${MODULE_ID}.settings.skillPointsLevelTable.name`,
            hint: `${MODULE_ID}.settings.skillPointsLevelTable.hint`,
            scope: "world",
            config: false,
            default: "",
            type: String,
        },
        skillPointsPerLevel: {
            name: `${MODULE_ID}.settings.skillPointsPerLevel.name`,
            hint: `${MODULE_ID}.settings.skillPointsPerLevel.hint`,
            scope: "world",
            config: true,
            default: 1,
            type: Number,
        },
        skillPointsFlatBonus: {
            name: `${MODULE_ID}.settings.skillPointsFlatBonus.name`,
            hint: `${MODULE_ID}.settings.skillPointsFlatBonus.hint`,
            scope: "world",
            config: true,
            default: 0,
            type: Number,
        },
        useFullscreen: {
            name: `${MODULE_ID}.settings.useFullscreen.name`,
            hint: `${MODULE_ID}.settings.useFullscreen.hint`,
            scope: "client",
            config: false,
            default: false,
            type: Boolean,
            onChange: value => {
                foundry.applications.instances.forEach(app => {
                    if (app instanceof SkillTreeActor) app.toggleFullscreen(value);
                });
            }
        },
    };

    registerSettingsArray(settings);

    game.settings.registerMenu(MODULE_ID, "skill-tree-manager", {
        name: `${MODULE_ID}.settings.skill-tree-manager.name`,
        label: `${MODULE_ID}.settings.skill-tree-manager.label`,
        hint: `${MODULE_ID}.settings.skill-tree-manager.hint`,
        icon: "fas fa-code-branch",
        type: SkillTreeManager,
        restricted: true,
    });

    game.settings.registerMenu(MODULE_ID, "skill-points-level-table", {
        name: `${MODULE_ID}.settings.skill-points-level-table.name`,
        label: `${MODULE_ID}.settings.skill-points-level-table.label`,
        hint: `${MODULE_ID}.settings.skill-points-level-table.hint`,
        icon: "fas fa-table-list",
        type: SkillPointsLevelTableConfig,
        restricted: true,
    });
}

export function getSetting(key) {
    return SETTING_CACHE[key] ?? game.settings.get(MODULE_ID, key);
}

export async function setSetting(key, value) {
    return await game.settings.set(MODULE_ID, key, value);
}

function registerSettingsArray(settings) {
    for (const [key, value] of Object.entries(settings)) {
        if (!value.name) value.name = `${MODULE_ID}.settings.${key}.name`
        if (!value.hint) value.hint = `${MODULE_ID}.settings.${key}.hint`
        if (value.useCache === undefined) value.useCache = DEFAULT_CACHE;
        if (value.useCache) {
            const unwrappedOnChange = value.onChange;
            if (value.onChange) value.onChange = (value) => {
                SETTING_CACHE[key] = value;
                if (unwrappedOnChange) unwrappedOnChange(value);
            }
        }
        game.settings.register(MODULE_ID, key, value);
        if(value.useCache) SETTING_CACHE[key] = getSetting(key);
    }
}