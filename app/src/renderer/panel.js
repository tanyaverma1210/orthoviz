// Side panel: structures grouped by type, each with a colour swatch and a show/hide toggle.

import { GROUPS } from "./anatomy.js";

// Quick filters: which groups each one shows.
const FILTERS = {
  all: GROUPS.map((g) => g.id),
  bones: ["spine", "bones"],
  spine: ["spine", "cord"],
};

export class StructurePanel {
  constructor({ list, filterButtons, viewer }) {
    this.list = list;
    this.filterButtons = filterButtons;
    this.viewer = viewer;
    this.rows = new Map(); // label -> {row, checkbox, group}
    this.groupToggles = new Map(); // group id -> checkbox

    for (const button of filterButtons) {
      button.addEventListener("click", () => this.applyFilter(button.dataset.filter));
    }
  }

  /** Rebuild the list for the viewer's current model. */
  render() {
    this.list.replaceChildren();
    this.rows.clear();
    this.groupToggles.clear();

    const structures = this.viewer.listStructures();
    for (const group of GROUPS) {
      const members = structures
        .filter((s) => s.info.group === group.id)
        .sort((a, b) => a.info.sortKey.localeCompare(b.info.sortKey));
      if (members.length === 0) continue;
      this.list.append(this._renderGroup(group, members));
    }
    this._syncControls();
  }

  /** Reflect the viewer's selection in the list. */
  showSelection(label) {
    for (const [l, { row, nameButton }] of this.rows) {
      const selected = l === label;
      row.classList.toggle("selected", selected);
      nameButton.setAttribute("aria-pressed", String(selected));
      if (selected) row.scrollIntoView({ block: "nearest" });
    }
  }

  applyFilter(filter) {
    const groups = new Set(FILTERS[filter]);
    for (const [label, { group }] of this.rows) this.viewer.setVisible(label, groups.has(group));
    this._syncControls();
    this.viewer.setView(null); // re-frame what is now visible, keeping the viewing angle
  }

  _renderGroup(group, members) {
    const section = document.createElement("section");
    section.className = "group";

    const header = document.createElement("label");
    header.className = "group-header";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.addEventListener("change", () => {
      for (const s of members) this.viewer.setVisible(s.label, toggle.checked);
      this._syncControls();
    });
    const title = document.createElement("span");
    title.className = "group-title";
    title.textContent = group.title;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(members.length);
    header.append(toggle, title, count);
    this.groupToggles.set(group.id, { toggle, labels: members.map((s) => s.label) });

    const ul = document.createElement("ul");
    for (const s of members) ul.append(this._renderRow(s));

    section.append(header, ul);
    return section;
  }

  _renderRow({ label, info }) {
    const row = document.createElement("li");
    row.className = "row";
    row.dataset.name = info.name;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `Show ${info.display}`);
    checkbox.addEventListener("change", () => {
      this.viewer.setVisible(label, checkbox.checked);
      this._syncControls();
    });

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = `#${info.color.toString(16).padStart(6, "0")}`;
    if (info.opacity !== undefined) swatch.classList.add("see-through");

    // Clicking the name selects (highlights and labels) the structure, showing it if hidden.
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "row-name";
    nameButton.textContent = info.display;
    nameButton.setAttribute("aria-pressed", "false");
    nameButton.addEventListener("click", () => {
      if (this.viewer.selected === label) return this.viewer.select(null);
      this.viewer.setVisible(label, true);
      this._syncControls();
      this.viewer.select(label);
    });

    row.append(checkbox, swatch, nameButton);
    this.rows.set(label, { row, checkbox, nameButton, group: info.group });
    return row;
  }

  /** Update checkboxes, group tri-states and the active quick filter from the viewer's state. */
  _syncControls() {
    const visible = new Map(this.viewer.listStructures().map((s) => [s.label, s.visible]));
    for (const [label, { row, checkbox }] of this.rows) {
      checkbox.checked = visible.get(label);
      row.classList.toggle("hidden-structure", !checkbox.checked);
    }
    for (const { toggle, labels } of this.groupToggles.values()) {
      const shown = labels.filter((l) => visible.get(l)).length;
      toggle.checked = shown === labels.length;
      toggle.indeterminate = shown > 0 && shown < labels.length;
    }
    for (const button of this.filterButtons) {
      const groups = new Set(FILTERS[button.dataset.filter]);
      const matches = [...this.rows].every(([label, { group }]) => visible.get(label) === groups.has(group));
      button.setAttribute("aria-pressed", String(matches));
    }
  }
}
