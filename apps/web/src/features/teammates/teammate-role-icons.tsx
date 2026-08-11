import {
  Brain,
  CheckCircle2,
  Code2,
  FileText,
  Palette,
  Rocket,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";

export function teammateRoleIcon(roleKey: string | undefined, size = 15): React.JSX.Element {
  if (roleKey === "product") return <Brain size={size} />;
  if (roleKey === "engineer") return <Code2 size={size} />;
  if (roleKey === "architect") return <Workflow size={size} />;
  if (roleKey === "designer") return <Palette size={size} />;
  if (roleKey === "qa") return <CheckCircle2 size={size} />;
  if (roleKey === "security") return <ShieldCheck size={size} />;
  if (roleKey === "release") return <Rocket size={size} />;
  if (roleKey === "docs") return <FileText size={size} />;
  return <Sparkles size={size} />;
}
