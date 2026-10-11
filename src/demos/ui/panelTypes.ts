/** 調整パネルの項目の型と、初期値の取り出し */
export type Slider = { key: string; label: string; min: number; max: number; step: number; def: number };
export type Toggle = { key: string; label: string; def: boolean; toggle: true };
export type Group = { title: string; items: (Slider | Toggle)[] };
export type Values = Record<string, number | boolean>;

export const defaultsOf = (groups: Group[]): Values =>
  Object.fromEntries(groups.flatMap((g) => g.items.map((i) => [i.key, i.def])));
