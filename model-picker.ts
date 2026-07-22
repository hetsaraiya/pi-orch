import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

type Theme = {
  fg(color: "text" | "accent" | "muted" | "dim" | "success" | "warning", text: string): string;
  bold(text: string): string;
};

export type ScopedModelChoice = {
  /** Stable provider/model identifier saved in pi-orch.json. */
  id: string;
  provider: string;
  modelId: string;
  name: string;
};

/**
 * A searchable picker deliberately modelled on Pi's native model selector.  It
 * receives an already scoped list: it never asks the registry for all models.
 */
export class ScopedModelPicker extends Container {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly choices: ScopedModelChoice[];
  private filtered: ScopedModelChoice[];
  private selectedIndex: number;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly title: string;
  private readonly allowInherit: boolean;
  private readonly currentId?: string;
  /** undefined means inherit; null means cancel. */
  private readonly done: (id: string | undefined | null) => void;
  private closed = false;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    title: string;
    choices: ScopedModelChoice[];
    currentId?: string;
    allowInherit?: boolean;
    onDone: (id: string | undefined | null) => void;
  }) {
    super();
    this.tui = options.tui;
    this.theme = options.theme;
    this.title = options.title;
    this.choices = options.choices;
    this.filtered = options.choices;
    this.currentId = options.currentId;
    this.allowInherit = options.allowInherit ?? false;
    this.done = options.onDone;
    const currentIndex = this.choices.findIndex(choice => choice.id === this.currentId);
    this.selectedIndex = this.allowInherit
      ? currentIndex >= 0 ? currentIndex + 1 : 0
      : Math.max(0, currentIndex);

    this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
    this.addChild(new Text(this.theme.fg("muted", "Scoped models only"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "↑↓ navigate • enter select • esc/ctrl+c cancel"), 1, 0));
    this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.refresh();
  }

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }

  private itemCount(): number { return this.filtered.length + (this.allowInherit ? 1 : 0); }

  private currentChoice(): ScopedModelChoice | undefined {
    return this.allowInherit && this.selectedIndex === 0 ? undefined : this.filtered[this.selectedIndex - (this.allowInherit ? 1 : 0)];
  }

  private refresh(): void {
    const query = this.search.getValue();
    this.filtered = query
      ? fuzzyFilter(this.choices, query, choice => `${choice.modelId} ${choice.provider} ${choice.name}`)
      : this.choices;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.itemCount() - 1));
    this.updateList();
  }

  private updateList(): void {
    this.list.clear();
    const total = this.itemCount();
    if (total === 0) {
      this.list.addChild(new Text(this.theme.fg("warning", "  No available models in the configured scope"), 0, 0));
      return;
    }
    const maxVisible = 10;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
    const end = Math.min(start + maxVisible, total);
    for (let index = start; index < end; index++) {
      const inherit = this.allowInherit && index === 0;
      const choice = inherit ? undefined : this.filtered[index - (this.allowInherit ? 1 : 0)];
      if (!inherit && !choice) continue;
      const selected = index === this.selectedIndex;
      const current = !inherit && choice!.id === this.currentId;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = inherit ? "Use orchestrator model (default)" : `${choice!.modelId} ${this.theme.fg("muted", `[${choice!.provider}]`)}`;
      const styledLabel = selected ? this.theme.fg("accent", label) : label;
      const mark = current ? this.theme.fg("success", " ✓") : "";
      this.list.addChild(new Text(`${prefix}${styledLabel}${mark}`, 0, 0));
    }
    if (start > 0 || end < total) this.list.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`), 0, 0));
    const choice = this.currentChoice();
    if (choice) {
      this.list.addChild(new Spacer(1));
      this.list.addChild(new Text(this.theme.fg("muted", `  Model Name: ${choice.name}`), 0, 0));
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      const total = this.itemCount();
      if (total) this.selectedIndex = this.selectedIndex === 0 ? total - 1 : this.selectedIndex - 1;
      this.updateList();
    } else if (kb.matches(data, "tui.select.down")) {
      const total = this.itemCount();
      if (total) this.selectedIndex = this.selectedIndex === total - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    } else if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.currentChoice();
      if (selected || this.allowInherit) this.finish(selected?.id);
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.finish(null);
    } else {
      this.search.handleInput(data);
      this.refresh();
    }
    this.tui.requestRender();
  }

  private finish(id: string | undefined | null): void {
    if (this.closed) return;
    this.closed = true;
    this.done(id);
  }

  override invalidate(): void {
    super.invalidate();
    this.updateList();
  }
}
