import { MODULE_ID } from "../consts.js";
import { HandlebarsApplication, l } from "../lib/utils.js";

function parseLevelTable(rawTable) {
    const rows = [];
    if (typeof rawTable !== "string" || !rawTable.trim().length) return rows;

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

        rows.push({
            id: foundry.utils.randomID(),
            level,
            relative: token.startsWith("+") || token.startsWith("-"),
            amount,
        });
    }

    return rows.sort((a, b) => a.level - b.level);
}

function normalizeRows(rows) {
    const normalized = [];
    const inputRows = Array.isArray(rows) ? rows : [];

    for (const row of inputRows) {
        const level = Number.isFinite(Number(row?.level)) ? parseInt(row.level) : NaN;
        const amount = Number.isFinite(Number(row?.amount)) ? parseInt(row.amount) : NaN;
        if (!Number.isFinite(level) || level < 1) continue;
        if (!Number.isFinite(amount)) continue;

        normalized.push({
            id: row.id ?? foundry.utils.randomID(),
            level,
            relative: !!row.relative,
            amount,
        });
    }

    const dedupedByLevel = new Map();
    for (const row of normalized) {
        dedupedByLevel.set(row.level, row);
    }

    return Array.from(dedupedByLevel.values()).sort((a, b) => a.level - b.level);
}

function serializeLevelTable(rows) {
    const normalized = normalizeRows(rows);
    return normalized
        .map((row) => {
            if (row.relative) {
                const token = row.amount >= 0 ? `+${row.amount}` : `${row.amount}`;
                return `${row.level}=${token}`;
            }
            return `${row.level}=${row.amount}`;
        })
        .join(", ");
}

export class SkillPointsLevelTableConfig extends HandlebarsApplication {
    constructor() {
        super();
        const rawTable = game.settings.get(MODULE_ID, "skillPointsLevelTable");
        this.rows = parseLevelTable(rawTable);
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

    static get DEFAULT_OPTIONS() {
        return {
            classes: [this.APP_ID],
            tag: "div",
            window: {
                frame: true,
                positioned: true,
                title: `${MODULE_ID}.${this.APP_ID}.title`,
                icon: "fas fa-table-list",
                controls: [],
                minimizable: true,
                resizable: false,
                contentTag: "section",
                contentClasses: [],
            },
            position: {
                width: 700,
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

    async _prepareContext() {
        const rows = normalizeRows(this.rows);
        return {
            rows,
            hasRows: rows.length > 0,
        };
    }

    readRowsFromForm() {
        const html = this.element;
        const rows = [];
        html.querySelectorAll(".level-table-row").forEach((rowEl) => {
            const id = rowEl.dataset.id;
            const levelInput = rowEl.querySelector("input[name='level']");
            const typeInput = rowEl.querySelector("select[name='type']");
            const amountInput = rowEl.querySelector("input[name='amount']");

            rows.push({
                id,
                level: parseInt(levelInput?.value ?? 0),
                relative: (typeInput?.value ?? "absolute") === "relative",
                amount: parseInt(amountInput?.value ?? 0),
            });
        });
        this.rows = normalizeRows(rows);
    }

    addRow() {
        const maxLevel = this.rows.length ? Math.max(...this.rows.map((row) => row.level)) : 0;
        this.rows.push({
            id: foundry.utils.randomID(),
            level: maxLevel + 1,
            relative: false,
            amount: 0,
        });
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        html.querySelector("button[name='add-row']")?.addEventListener("click", (event) => {
            event.preventDefault();
            this.readRowsFromForm();
            this.addRow();
            this.render(true);
        });

        html.querySelectorAll("button[name='delete-row']").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                this.readRowsFromForm();
                const rowId = event.currentTarget.dataset.id;
                this.rows = this.rows.filter((row) => row.id !== rowId);
                this.render(true);
            });
        });

        html.querySelector("button[name='save']")?.addEventListener("click", async (event) => {
            event.preventDefault();
            this.readRowsFromForm();
            const serialized = serializeLevelTable(this.rows);
            await game.settings.set(MODULE_ID, "skillPointsLevelTable", serialized);
            ui.notifications.info(l(`${MODULE_ID}.${this.APP_ID}.saved`));
            this.close();
        });

        html.querySelector("button[name='cancel']")?.addEventListener("click", async (event) => {
            event.preventDefault();
            this.close();
        });
    }
}
