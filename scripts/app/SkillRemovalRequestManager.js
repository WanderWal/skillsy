import { MODULE_ID } from "../consts.js";
import { getPointBuildConfigs } from "../config.js";
import { HandlebarsApplication, l } from "../lib/utils.js";
import { resolveSkillRemovalRequest } from "./SkillTreeActor.js";

function getPendingRemovalRequests(actor) {
    const rows = actor?.getFlag(MODULE_ID, "skillRemovalRequests") ?? [];
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row?.status === "pending");
}

export class SkillRemovalRequestManager extends HandlebarsApplication {
    static get DEFAULT_OPTIONS() {
        return {
            classes: [this.APP_ID],
            tag: "div",
            window: {
                frame: true,
                positioned: true,
                title: `${MODULE_ID}.${this.APP_ID}.title`,
                icon: "fas fa-clipboard-check",
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
                width: 900,
                height: "auto",
            },
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
        const builds = getPointBuildConfigs();
        const buildNameMap = new Map(builds.map((build) => [build.id, build.name]));

        const requests = [];
        for (const actor of game.actors ?? []) {
            for (const request of getPendingRemovalRequests(actor)) {
                const requestedBy = game.users.get(request.requestedByUserId);
                requests.push({
                    id: request.id,
                    actorId: actor.id,
                    actorName: actor.name,
                    skillName: request.skillName ?? l(`${MODULE_ID}.skill-removal-request-manager.unknown-skill`),
                    buildName: buildNameMap.get(request.buildId) ?? request.buildId ?? "",
                    requestedByName: requestedBy?.name ?? request.requestedByUserName ?? l(`${MODULE_ID}.skill-removal-request-manager.unknown-user`),
                    requestedAt: request.requestedAt ?? "",
                });
            }
        }

        requests.sort((a, b) => {
            const aTime = new Date(a.requestedAt || 0).getTime();
            const bTime = new Date(b.requestedAt || 0).getTime();
            return bTime - aTime;
        });

        return {
            requests,
            hasRequests: requests.length > 0,
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        html.querySelectorAll("button[name='approve-request']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const actorId = event.currentTarget.dataset.actorId;
                const requestId = event.currentTarget.dataset.requestId;
                const actor = game.actors.get(actorId);
                if (!actor || !requestId) return;

                await resolveSkillRemovalRequest(actor, requestId, { approve: true });
                ui.notifications.info(l(`${MODULE_ID}.skill-removal-request-manager.approved`));
                this.render(true);
            });
        });

        html.querySelectorAll("button[name='reject-request']").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.preventDefault();
                const actorId = event.currentTarget.dataset.actorId;
                const requestId = event.currentTarget.dataset.requestId;
                const actor = game.actors.get(actorId);
                if (!actor || !requestId) return;

                await resolveSkillRemovalRequest(actor, requestId, { approve: false });
                ui.notifications.info(l(`${MODULE_ID}.skill-removal-request-manager.rejected`));
                this.render(true);
            });
        });
    }
}
