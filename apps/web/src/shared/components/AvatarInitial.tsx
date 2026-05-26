export type AvatarTone = "default" | "orange" | "teal" | "violet" | "blue" | "rose" | "gray";

export function AvatarInitial({ label, tone = "default" }: { readonly label: string; readonly tone?: AvatarTone }): JSX.Element {
  return <span className={`avatar-initial ${tone}`}>{label}</span>;
}
