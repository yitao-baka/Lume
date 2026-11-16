import { For } from "solid-js";

/** Render a native shortcut such as `Ctrl+Alt+Space` as individual keycaps. */
export function HotkeyKeys(props: { combo: string; class?: string }) {
  const parts = () => props.combo.split("+").map((part) => part.trim()).filter(Boolean);
  return (
    <span class={`onboarding-keys ${props.class ?? ""}`} aria-label={props.combo}>
      <For each={parts()}>
        {(part, index) => (
          <>
            {index() > 0 && <span class="onboarding-key-plus" aria-hidden="true">+</span>}
            <kbd class="onboarding-key">{part}</kbd>
          </>
        )}
      </For>
    </span>
  );
}
