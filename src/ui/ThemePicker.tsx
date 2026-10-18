/**
 * Theme picker.
 *
 * A native `<select>`, not a custom dropdown. The theme list is short and rarely
 * changed, and a native control already works with a keyboard, a screen reader,
 * and the mobile picker — three things a bespoke menu would have to reimplement
 * and get wrong.
 */

import { THEMES } from './theme';

export function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <label className="theme">
      <span className="visually-hidden">Theme</span>
      <select className="theme__select" value={value} onChange={(event) => onChange(event.target.value)}>
        {THEMES.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.name}
          </option>
        ))}
      </select>
    </label>
  );
}
