import { MODULE_ID, POINT_BUILDS_SETTING_KEY } from "./consts.js";
import { HandlebarsApplication, l } from "./lib/utils.js";
import { FormBuilder } from "./lib/formBuilder.js";

const DEFAULT_POINT_BUILD = {
	id: "default",
	name: "Default Build",
	maxPoints: 6,
	plannedSkills: [],
};

function getPointBuildSkillTrees() {
	return game.journal
		.filter((j) => j.getFlag(MODULE_ID, "isSkillTree"))
		.sort((a, b) => a.sort - b.sort);
}

function getBuildSkillOptions() {
	const skillTrees = getPointBuildSkillTrees();
	const options = [];
	for (const tree of skillTrees) {
		for (const page of tree.pages) {
			options.push({ key: page.uuid, label: `${tree.name} • ${page.name}` });
		}
	}
	return options;
}

function normalizePlannedSkillEntries(values, options = []) {
	const entries = Array.isArray(values) ? values : [];
	const optionByIndex = new Map(options.map((option, index) => [String(index), option.key]));
	const normalized = [];

	for (const entry of entries) {
		if (typeof entry === "string" && entry.length > 0) {
			const resolvedUuid = optionByIndex.get(entry) ?? entry;
			normalized.push({ uuid: resolvedUuid });
			continue;
		}

		const rawUuid = typeof entry?.uuid === "string" ? entry.uuid : "";
		const uuid = optionByIndex.get(rawUuid) ?? rawUuid;
		if (!uuid) continue;

		const costValue = Number(entry?.cost);
		const cost = Number.isFinite(costValue) && parseInt(costValue) > 0 ? parseInt(costValue) : undefined;
		normalized.push(cost ? { uuid, cost } : { uuid });
	}

	return normalized.filter((entry, index, all) => all.findIndex((candidate) => candidate.uuid === entry.uuid) === index);
}

function normalizeUuidSelection(values) {
	if (!values) return [];
	if (values instanceof Set) return Array.from(values).filter((value) => typeof value === "string" && value.length > 0).filter((value, index, all) => all.indexOf(value) === index);
	if (Array.isArray(values)) return values.filter((value) => typeof value === "string" && value.length > 0).filter((value, index, all) => all.indexOf(value) === index);
	if (typeof values === "string" && values.length > 0) return [values];
	return [];
}

function getBuildSkillPickerTreeContext(skillTree, selectedUuids = []) {
	if (!skillTree) return { groups: [], useCircleStyle: false };

	const selected = new Set(normalizeUuidSelection(selectedUuids));
	const groups = foundry.utils.deepClone(skillTree.getFlag(MODULE_ID, "groups") ?? []);
	const pages = Array.from(skillTree.pages);

	for (const group of groups) {
		let maxRow = 0;
		let maxCol = 0;
		const skills = pages.filter((page) => page.getFlag(MODULE_ID, "groupId") === group.id);

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
		for (let row = 0; row < maxRow + 1; row++) {
			for (let col = 0; col < maxCol + 1; col++) {
				const skill = skills.find((page) => page.getFlag(MODULE_ID, "row") === row && page.getFlag(MODULE_ID, "col") === col);
				if (skill) {
					const points = Math.max(0, parseInt(skill.getFlag(MODULE_ID, "points") ?? 0));
					const overrideStyle = (skill.getFlag(MODULE_ID, "skillStyle") ?? "default") !== "default";
					const overrideStyleClass = skill.getFlag(MODULE_ID, "skillStyle") === "circle" ? "round" : "";
					children.push({
						...skill,
						row,
						col,
						uuid: skill.uuid,
						selected: selected.has(skill.uuid),
						points: points > 1 ? points : 0,
						overrideStyle,
						overrideStyleClass,
					});
				} else {
					children.push({ row, col });
				}
			}
		}

		group.children = children;
	}

	const skillStyle = skillTree.getFlag(MODULE_ID, "skillStyle") ?? "square";
	return { groups, useCircleStyle: skillStyle === "circle" };
}

export function getPlannedBuildSkillRows(build) {
	const plannedSkills = normalizePlannedSkillEntries(build?.plannedSkills);
	const count = plannedSkills.length;
	if (!count) return [];

	const maxPoints = Math.max(0, parseInt(build?.maxPoints ?? 0));
	const rows = plannedSkills.map((entry) => ({ uuid: entry.uuid, maxCost: 1, manual: Number.isFinite(Number(entry?.cost)) && parseInt(entry.cost) > 0 }));

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

export function getDerivedSkillPointMap(builds = getPointBuildConfigs()) {
	const normalizedBuilds = normalizePointBuilds(builds);
	const aggregateCosts = new Map();
	const manualOverrides = new Map();

	for (const build of normalizedBuilds) {
		const plannedEntries = normalizePlannedSkillEntries(build.plannedSkills);
		for (const entry of plannedEntries) {
			const manualCost = Number.isFinite(Number(entry?.cost)) ? parseInt(entry.cost) : 0;
			if (manualCost > 0) {
				const normalizedCost = Math.max(1, manualCost);
				const current = manualOverrides.get(entry.uuid);
				manualOverrides.set(entry.uuid, current === undefined ? normalizedCost : Math.min(current, normalizedCost));
			}
		}

		for (const row of getPlannedBuildSkillRows(build)) {
			const current = aggregateCosts.get(row.uuid);
			const normalizedCost = Math.max(1, parseInt(row.maxCost ?? 1));
			aggregateCosts.set(row.uuid, current === undefined ? normalizedCost : Math.min(current, normalizedCost));
		}
	}

	const derived = new Map();
	const allSkillUuids = new Set([...aggregateCosts.keys(), ...manualOverrides.keys()]);
	for (const uuid of allSkillUuids) {
		if (manualOverrides.has(uuid)) {
			derived.set(uuid, manualOverrides.get(uuid));
			continue;
		}
		const value = aggregateCosts.get(uuid) ?? 1;
		derived.set(uuid, value);
	}

	return derived;
}

function getBuildPointSummary(build, derivedPoints) {
	const entries = normalizePlannedSkillEntries(build?.plannedSkills);
	const total = entries.reduce((sum, entry) => sum + Math.max(0, parseInt(derivedPoints.get(entry.uuid) ?? 0)), 0);
	const maxPoints = Math.max(0, parseInt(build?.maxPoints ?? 0));
	const delta = total - maxPoints;
	return {
		total,
		maxPoints,
		delta,
		mismatch: delta !== 0,
	};
}

export async function syncDerivedSkillPoints(builds = getPointBuildConfigs()) {
	const derivedPoints = getDerivedSkillPointMap(builds);
	for (const [uuid, points] of derivedPoints.entries()) {
		const page = await fromUuid(uuid);
		if (!page || page.documentName !== "JournalEntryPage") continue;
		const current = parseInt(page.getFlag(MODULE_ID, "points") ?? 1);
		if (current === points) continue;
		await page.setFlag(MODULE_ID, "points", points);
	}
}

export function normalizePointBuilds(builds) {
	const rows = Array.isArray(builds) ? builds : [];
	const skillOptions = getBuildSkillOptions();
	const normalized = rows
		.map((build) => {
			const id = typeof build?.id === "string" && build.id.trim() ? build.id.trim() : foundry.utils.randomID();
			const name = typeof build?.name === "string" && build.name.trim() ? build.name.trim() : DEFAULT_POINT_BUILD.name;
			const maxPoints = Number.isFinite(Number(build?.maxPoints)) ? Math.max(0, parseInt(build.maxPoints)) : DEFAULT_POINT_BUILD.maxPoints;
			const plannedSkills = normalizePlannedSkillEntries(build?.plannedSkills, skillOptions);
			return { id, name, maxPoints, plannedSkills };
		})
		.filter((build, index, all) => all.findIndex((candidate) => candidate.id === build.id) === index);

	if (!normalized.length) normalized.push(foundry.utils.deepClone(DEFAULT_POINT_BUILD));
	return normalized;
}

export function getPointBuildConfigs() {
	return normalizePointBuilds(game.settings.get(MODULE_ID, POINT_BUILDS_SETTING_KEY));
}

class PointBuildSkillPicker extends HandlebarsApplication {
	constructor(build) {
		super();
		this.build = build;
		this.skillTrees = getPointBuildSkillTrees();
		this.selectedEntries = normalizePlannedSkillEntries(build?.plannedSkills);
		this.entryCache = new Map(this.selectedEntries.map((entry) => [entry.uuid, entry]));
		this.activeSkillTreeUuid = this.#getInitialSkillTreeUuid();
		this.#result = new Promise((resolve) => {
			this.#resolveResult = resolve;
		});
	}

	#resolveResult;
	#resolved = false;
	#result;

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
			classes: [this.APP_ID, "skill-tree-actor"],
			tag: "div",
			window: {
				frame: true,
				positioned: true,
				title: `${MODULE_ID}.${this.APP_ID}.title`,
				icon: "fas fa-list-check",
				controls: [],
				minimizable: true,
				resizable: true,
				contentTag: "section",
				contentClasses: [],
			},
			position: {
				height: "auto",
			},
		};
	}

	static get PARTS() {
		return {
			content: {
				template: `modules/${MODULE_ID}/templates/${this.APP_ID}.hbs`,
				classes: ["scrollable"],
				scrollable: [".skill-groups"],
			},
		};
	}

	get title() {
		return l(`${MODULE_ID}.${this.APP_ID}.title`).replace("%s", this.build?.name ?? "");
	}

	#getInitialSkillTreeUuid() {
		if (!this.skillTrees.length) return null;
		const selectedUuids = new Set(this.selectedEntries.map((entry) => entry.uuid));
		const matchingTree = this.skillTrees.find((tree) => Array.from(tree.pages).some((page) => selectedUuids.has(page.uuid)));
		return matchingTree?.uuid ?? this.skillTrees[0].uuid;
	}

	get activeSkillTree() {
		return this.skillTrees.find((tree) => tree.uuid === this.activeSkillTreeUuid) ?? this.skillTrees[0] ?? null;
	}

	async waitForSelection() {
		this.render(true);
		return this.#result;
	}

	resolve(result = null) {
		if (this.#resolved) return;
		this.#resolved = true;
		this.#resolveResult(result);
	}

	toggleSkill(uuid) {
		const existingIndex = this.selectedEntries.findIndex((entry) => entry.uuid === uuid);
		if (existingIndex >= 0) {
			this.selectedEntries.splice(existingIndex, 1);
			return;
		}

		const cached = this.entryCache.get(uuid);
		this.selectedEntries.push(cached?.cost ? { uuid, cost: cached.cost } : { uuid });
	}

	async _prepareContext() {
		const activeSkillTree = this.activeSkillTree;
		const selectedUuids = this.selectedEntries.map((entry) => entry.uuid);
		const treeContext = getBuildSkillPickerTreeContext(activeSkillTree, selectedUuids);

		return {
			...treeContext,
			hasSkillTrees: !!activeSkillTree,
			skillTreeName: activeSkillTree?.name ?? "",
			skillTreesOptions: this.skillTrees.map((tree) => ({
				key: tree.uuid,
				label: tree.name,
				selected: tree.uuid === activeSkillTree?.uuid,
			})),
			selectedCount: selectedUuids.length,
		};
	}

	_onRender(context, options) {
		super._onRender(context, options);
		const html = this.element;

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
				button.addEventListener("click", (event) => {
					event.preventDefault();
					const selectedUuid = event.currentTarget.dataset.value;
					if (!selectedUuid || selectedUuid === this.activeSkillTreeUuid) {
						closeSkillTreeMenu();
						return;
					}
					this.activeSkillTreeUuid = selectedUuid;
					this.render(true);
				});
			});

			html.addEventListener("click", (event) => {
				if (!selector?.contains(event.target)) closeSkillTreeMenu();
			});
		}

		html.querySelectorAll(".skill-container[data-uuid]").forEach((skillContainer) => {
			skillContainer.addEventListener("click", (event) => {
				event.preventDefault();
				const skillUuid = event.currentTarget.dataset.uuid;
				if (!skillUuid) return;
				this.toggleSkill(skillUuid);
				this.render(true);
			});
		});

		html.querySelector("button[name='save-selection']")?.addEventListener("click", async (event) => {
			event.preventDefault();
			this.resolve(this.selectedEntries.map((entry) => (entry.cost ? { uuid: entry.uuid, cost: entry.cost } : { uuid: entry.uuid })));
			await this.close();
		});

		html.querySelector("button[name='cancel-selection']")?.addEventListener("click", async (event) => {
			event.preventDefault();
			this.resolve(null);
			await this.close();
		});
	}

	_onClose(options) {
		super._onClose(options);
		this.resolve(null);
	}
}

export class SkillTreeBuildConfig extends HandlebarsApplication {
	constructor() {
		super();
		this.builds = getPointBuildConfigs();
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
				icon: "fas fa-layer-group",
				controls: [],
				minimizable: true,
				resizable: true,
				contentTag: "section",
				contentClasses: [],
			},
			position: {
				width: 1120,
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
		const optionsByUuid = new Map(this.getBuildSkillOptions().map((option) => [option.key, option.label]));
		const derivedPoints = getDerivedSkillPointMap(this.builds);
		const resolveSkillLabel = (uuid) => {
			const fromOptions = optionsByUuid.get(uuid);
			if (fromOptions) return fromOptions;
			const fromDoc = fromUuidSync(uuid);
			if (fromDoc?.name) return fromDoc.name;
			return uuid;
		};

		const builds = this.builds.map((build, index, all) => ({
			...build,
			index,
			plannedSkillsCount: normalizePlannedSkillEntries(build.plannedSkills).length,
			pointSummary: getBuildPointSummary(build, derivedPoints),
			finalCosts: getPlannedBuildSkillRows(build).map((row) => ({
				uuid: row.uuid,
				label: resolveSkillLabel(row.uuid),
				buildCost: row.maxCost,
				derivedCost: derivedPoints.get(row.uuid) ?? row.maxCost,
				showDerived: (derivedPoints.get(row.uuid) ?? row.maxCost) !== row.maxCost,
				manual: row.manual,
			})),
			canMoveUp: index > 0,
			canMoveDown: index < all.length - 1,
		}));

		return { builds };
	}

	getBuildSkillOptions() {
		return getBuildSkillOptions();
	}

	async editBuildSkills(index) {
		if (!Number.isFinite(index)) return;
		const build = this.builds[index];
		if (!build) return;

		if (!getPointBuildSkillTrees().length) {
			ui.notifications.warn(l(`${MODULE_ID}.skill-tree-actor.no-skill-trees`));
			return;
		}

		const picker = new PointBuildSkillPicker(build);
		const plannedSkills = await picker.waitForSelection();
		if (!plannedSkills) return;

		this.builds[index].plannedSkills = normalizePlannedSkillEntries(plannedSkills);
		this.render(true);
	}

	async editBuildSkillCosts(index) {
		if (!Number.isFinite(index)) return;
		const build = this.builds[index];
		if (!build) return;

		const options = this.getBuildSkillOptions();
		const currentEntries = normalizePlannedSkillEntries(build.plannedSkills, options);
		if (!currentEntries.length) {
			ui.notifications.warn(l(`${MODULE_ID}.skill-tree-build-config.no-skills`));
			return;
		}

		const optionsByUuid = new Map(options.map((option) => [option.key, option.label]));
		const overrideForm = new FormBuilder()
			.title(l(`${MODULE_ID}.skill-tree-build-config.edit-costs-title`).replace("%s", build.name))
			.info(l(`${MODULE_ID}.skill-tree-build-config.edit-skills-costs-hint`));

		for (const [skillIndex, entry] of currentEntries.entries()) {
			overrideForm.number({
				name: `costs.${skillIndex}`,
				label: optionsByUuid.get(entry.uuid) ?? entry.uuid,
				hint: l(`${MODULE_ID}.skill-tree-build-config.edit-skills-costs-field-hint`),
				min: 0,
				step: 1,
				value: parseInt(entry.cost ?? 0),
			});
		}

		const overrideData = await overrideForm.render();
		if (!overrideData) return;

		const rawCosts = overrideData.costs;
		const plannedSkills = currentEntries.map((entry, skillIndex) => {
			const rawValue = Array.isArray(rawCosts) ? rawCosts[skillIndex] : rawCosts?.[skillIndex];
			const parsed = Number.isFinite(Number(rawValue)) ? parseInt(rawValue) : 0;
			return parsed > 0 ? { uuid: entry.uuid, cost: parsed } : { uuid: entry.uuid };
		});

		this.builds[index].plannedSkills = plannedSkills;
		this.render(true);
	}

	_onRender(context, options) {
		super._onRender(context, options);
		const html = this.element;

		html.querySelectorAll("input[name='build-name']").forEach((input) => {
			input.addEventListener("change", (event) => {
				const index = parseInt(event.currentTarget.dataset.index);
				if (!Number.isFinite(index)) return;
				this.builds[index].name = event.currentTarget.value;
			});
		});

		html.querySelectorAll("input[name='build-max-points']").forEach((input) => {
			input.addEventListener("change", (event) => {
				const index = parseInt(event.currentTarget.dataset.index);
				if (!Number.isFinite(index)) return;
				const value = Number.isFinite(Number(event.currentTarget.value)) ? parseInt(event.currentTarget.value) : 0;
				this.builds[index].maxPoints = Math.max(0, value);
				event.currentTarget.value = this.builds[index].maxPoints;
			});
		});

		html.querySelectorAll("button[name='edit-build-skills']").forEach((button) => {
			button.addEventListener("click", async (event) => {
				event.preventDefault();
				const index = parseInt(event.currentTarget.dataset.index);
				await this.editBuildSkills(index);
			});
		});

		html.querySelectorAll("button[name='edit-build-costs']").forEach((button) => {
			button.addEventListener("click", async (event) => {
				event.preventDefault();
				const index = parseInt(event.currentTarget.dataset.index);
				await this.editBuildSkillCosts(index);
			});
		});

		html.querySelector("button[name='new-build']")?.addEventListener("click", (event) => {
			event.preventDefault();
			this.builds.push({
				id: foundry.utils.randomID(),
				name: DEFAULT_POINT_BUILD.name,
				maxPoints: DEFAULT_POINT_BUILD.maxPoints,
				plannedSkills: [],
			});
			this.render(true);
		});

		html.querySelectorAll("button[name='move-up']").forEach((button) => {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				const index = parseInt(event.currentTarget.dataset.index);
				if (!Number.isFinite(index) || index <= 0) return;
				const current = this.builds[index];
				this.builds.splice(index, 1);
				this.builds.splice(index - 1, 0, current);
				this.render(true);
			});
		});

		html.querySelectorAll("button[name='move-down']").forEach((button) => {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				const index = parseInt(event.currentTarget.dataset.index);
				if (!Number.isFinite(index) || index >= this.builds.length - 1) return;
				const current = this.builds[index];
				this.builds.splice(index, 1);
				this.builds.splice(index + 1, 0, current);
				this.render(true);
			});
		});

		html.querySelectorAll("button[name='delete-build']").forEach((button) => {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				const index = parseInt(event.currentTarget.dataset.index);
				if (!Number.isFinite(index)) return;
				this.builds.splice(index, 1);
				if (!this.builds.length) {
					this.builds.push({
						id: foundry.utils.randomID(),
						name: DEFAULT_POINT_BUILD.name,
						maxPoints: DEFAULT_POINT_BUILD.maxPoints,
						plannedSkills: [],
					});
				}
				this.render(true);
			});
		});

		html.querySelector("button[name='save']")?.addEventListener("click", async (event) => {
			event.preventDefault();
			const normalized = normalizePointBuilds(this.builds);
			await game.settings.set(MODULE_ID, POINT_BUILDS_SETTING_KEY, normalized);
			await syncDerivedSkillPoints(normalized);
			ui.notifications.info(l(`${MODULE_ID}.${this.APP_ID}.saved`));
			this.close();
		});
	}
}

export function initConfig() {
	game.settings.register(MODULE_ID, POINT_BUILDS_SETTING_KEY, {
		scope: "world",
		config: false,
		default: [foundry.utils.deepClone(DEFAULT_POINT_BUILD)],
		type: Array,
	});

	game.settings.registerMenu(MODULE_ID, `${POINT_BUILDS_SETTING_KEY}-menu`, {
		name: `${MODULE_ID}.settings.point-build-config.name`,
		label: `${MODULE_ID}.settings.point-build-config.label`,
		hint: `${MODULE_ID}.settings.point-build-config.hint`,
		icon: "fas fa-layer-group",
		type: SkillTreeBuildConfig,
		restricted: true,
	});
}