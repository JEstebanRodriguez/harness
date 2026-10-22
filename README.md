# xjergx harness

Harness de desarrollo que decide, ticket por ticket, cuánto proceso aplicar. Puede ser **ODD**, **RDD** o **SDD**,
y funciona con cualquier agente de código: Claude Code, OpenCode, Codex, Pi o cualquier otro que pueda leer un archivo.

| Carril | Para qué tickets | Qué hace |
|---|---|---|
| **ODD** · [Organic Driven Development](https://fly.io/ruby-dispatch/organic-test-driven-development/) | Chicos, o con un diseño que hay que descubrir | Se bosqueja el uso, se hace correr y se agregan pocos tests por tramo. |
| **RDD** · [Requirement Driven Development](https://mehdiparsaeigm.medium.com/introducing-requirement-driven-development-rdd-a-pragmatic-approach-to-software-development-e7329a82f2d3) | Medianos, con requisitos conocidos | Primero los casos de uso. Después tests del happy path, el núcleo, y al final E2E para los casos malo y peor. |
| **SDD** · Spec Driven Development | Grandes o riesgosos | Exploración, entrevista de arquitectura con ADR, contrato OpenSpec, código y auditoría estricta. |

## Cómo se decide el carril

1. El agente **`xjergx-classifier`** mira el código y reporta señales objetivas en `classification.json`:
   - archivos que va a tocar
   - si cambia un contrato (schema, API pública, integración)
   - si toca un área sensible (auth, pagos, datos personales)
   - si abarca varios repos
   - qué tan claros son los requisitos
   - qué tan conocido es el diseño
2. La CLI aplica **reglas fijas** sobre esas señales (`src/router.js`). Así la decisión es reproducible y testeable:
   - Contrato, área sensible, multi-repo o ≥ 9 archivos → **SDD**
   - Diseño desconocido en un cambio amplio (> 5 archivos) → **SDD**
   - Requisitos poco claros → **RDD** (el analista los fija con vos)
   - ≤ 2 archivos, o diseño a descubrir con ≤ 5 archivos → **ODD**
   - Todo lo demás → **RDD**
3. El carril y sus motivos quedan guardados en el backlog. Podés forzarlo con `--lane` al crear el ticket o después
   con `xjergx lane <ID> <carril>`.
4. **Escalado:** si una fase descubre que el ticket es más grande de lo previsto, escribe `escalation.json` y el ticket
   sube de carril (ODD → RDD → SDD). Nunca baja solo.

Los umbrales se ajustan en `.xjergx/config.json` (`router.oddMaxFiles`, `router.oddExploreMaxFiles`, `router.sddMinFiles`).

## Fases por carril

```
ODD:  clasificar → build → archive
RDD:  clasificar → requirements 🛑 → build → review ↺ → archive
SDD:  clasificar → explore → design (entrevista) → spec 🛑 → build → review ↺ → archive
```

- 🛑 **Gate:** en modo `interactive` y `dry-run` vos aprobás el documento antes de que se escriba código. Si lo
  rechazás, la fase se repite con tu comentario.
- ↺ Si la revisión falla (`Status: FAILED`), vuelve a `build` con la auditoría. Después de `maxReviewRetries` (3)
  intentos fallidos, el ticket queda bloqueado.
- **archive** guarda lo aprendido en `.xjergx/engram/<ID>.md`. Los próximos tickets lo usan como memoria.

La CLI solo avanza cuando el artefacto de la fase existe y es válido. Un reporte con `Status: DONE`, una auditoría con
`Status: PASSED` o un JSON de clasificación que respeta el esquema cuentan como válidos.

## Instalación

Requiere Node ≥ 18.17, sin dependencias.

```bash
npm install -g github:JEstebanRodriguez/harness
# o, desde un clon:  npm link
```

En la raíz de tu workspace (el repo, o la carpeta que contiene varios repos):

```bash
xjergx init
xjergx add "Agregar exportación CSV de pedidos"
xjergx add "Corregir typo en el footer" --lane odd
xjergx status
```

## Dos formas de usarlo con tu agente

### 1. Modo driver: xjergx lanza al agente

```bash
xjergx run --agent claude      # o opencode | codex | pi | manual
xjergx run --agent codex --mode yolo
xjergx run --step              # una sola fase
```

- **Fases conversacionales** (design, requirements, build): xjergx abre una sesión interactiva del agente. Cuando la
  fase termina, cerrás la sesión y el harness verifica el resultado y sigue.
- **Fases sin conversación** (classify, explore, review, archive), y todas en modo `yolo`: corren en modo headless.
- **`--agent manual`** funciona con cualquier herramienta. Imprime una línea para pegarle a tu agente; cuando termina,
  ejecutás `xjergx run` de nuevo.

| Agente | Interactivo | Headless |
|---|---|---|
| claude | `claude "<prompt>"` | `claude -p "<prompt>" --permission-mode acceptEdits` |
| opencode | `opencode --prompt "<prompt>"` | `opencode run "<prompt>"` |
| codex | `codex "<prompt>"` | `codex exec --full-auto "<prompt>"` |
| pi | `pi "<prompt>"` | `pi -p "<prompt>"` |

Podés cambiar cualquiera de estos comandos, o agregar agentes nuevos, en `.xjergx/config.json`:

```json
{
  "agent": "claude",
  "adapters": {
    "claude": { "headless": ["-p", "{prompt}", "--dangerously-skip-permissions"] },
    "aider":  { "bin": "aider", "interactive": ["--message", "{prompt}"], "headless": ["--yes", "--message", "{prompt}"] }
  }
}
```

`{prompt}` es una sola línea que apunta al archivo de instrucciones de la fase (`.xjergx/prompts/<ID>-<fase>.md`).
Por eso no hay límites de longitud ni problemas de comillas.

### 2. Modo host: tu agente orquesta

```bash
xjergx install claude     # .claude/commands/xjergx.md + .claude/agents/xjergx-*.md
xjergx install opencode   # .opencode/command/xjergx.md + .opencode/agent/xjergx-*.md + AGENTS.md
xjergx install codex      # sección en AGENTS.md
xjergx install pi         # .pi/prompts/xjergx.md + AGENTS.md
xjergx install all
```

Dentro del agente usás `/xjergx` (Claude Code, OpenCode, Pi), o le pedís "trabajá el backlog de xjergx" (Codex lee
AGENTS.md). El agente repite `xjergx next --json` y hace lo que indica la respuesta:

| `action` | Qué hace el agente |
|---|---|
| `run_phase` | Ejecuta `promptFile`, o lo delega al subagente indicado en `agent` |
| `approve` | Te muestra el documento. Según tu respuesta corre `xjergx approve` o `xjergx reject --note "..."` |
| `done` / `idle` / `stop` / `blocked` | Termina y te informa |

En los dos modos los prompts son los mismos: un solo lugar de verdad en `agents/`. Los subagentes generados son
stubs que leen el archivo de fase, así que no duplican contenido. Commiteá los archivos que genera `install`
(el preflight exige un árbol limpio para empezar un ticket).

## Modos de ejecución

| Modo | Comportamiento |
|---|---|
| `interactive` (default) | Human-in-the-loop: entrevistas, gates de aprobación y pausas de revisión. |
| `yolo` | Sin intervención humana: sin gates, todo headless, las suposiciones quedan escritas en los artefactos. **Cuidado.** |
| `dry-run` | Corre hasta tener el plan (requirements o spec) y se detiene antes de cualquier fase que escriba código. |

Se elige con `--mode <modo>` (o `--yolo` / `--dry-run`, como en v0.1) o con `mode` en la config.

## Personalizar los roles

Copiá cualquier `agents/<nombre>.md` a `.xjergx/agents/<nombre>.md` en tu proyecto y editalo. La copia del proyecto
tiene prioridad sobre la del paquete.

## Estructura del workspace

```
.xjergx/
  backlog.json            estado (no editar a mano mientras corre)
  config.json
  tasks/<ID>/             artefactos del ticket: classification.json, problem.md, requirements.md,
                          context.md, adr.md, spec.md, build-report.md, audit.md, history/
  engram/<ID>.md          memoria del proyecto
  prompts/                instrucciones generadas por fase (ignorado por git)
  agents/                 overrides opcionales de los roles
```

## Comandos

```
xjergx init | add | status | lane <ID> <carril>
xjergx run  [--agent] [--mode] [--task] [--step] [--skip-preflight]
xjergx next [--json] [--task] [--mode]
xjergx approve | reject --note "..." | unblock [--phase <fase>]
xjergx install <claude|opencode|codex|pi|all>
```

## Migración desde v0.1 (`xjergx.sh`)

Un `backlog.json` existente sigue funcionando sin cambios:
- `type: "hotfix"` pasa al carril ODD.
- Los estados `spec_ready`, `coding` y `archiving` se mapean a las fases SDD equivalentes.
- El `xjergx-hotfixer` lo reemplaza `xjergx-odd-builder`.
- `xjergx-spec-code-review` ahora se llama `xjergx-code-reviewer`.

## Desarrollo

```bash
npm test   # router, máquina de estados, instalación y flujos completos con un agente falso
```
