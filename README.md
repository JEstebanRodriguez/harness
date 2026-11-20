# xjergx harness

Harness de desarrollo que hace dos cosas:

1. **Decide, ticket por ticket, cuánto proceso aplicar:** **ODD**, **RDD** o **SDD**.
2. **Comparte memoria, skills, agents y el estado de la sesión entre agentes de código.** Podés empezar algo en
   Codex y seguirlo en Claude Code, OpenCode, Pi u omp sin perder el contexto.

| Carril | Para qué tickets | Qué hace |
|---|---|---|
| **ODD** · [Organic Driven Development](https://fly.io/ruby-dispatch/organic-test-driven-development/) | Chicos, o con un diseño que hay que descubrir | Se bosqueja el uso, se hace correr y se agregan pocos tests por tramo. |
| **RDD** · [Requirement Driven Development](https://mehdiparsaeigm.medium.com/introducing-requirement-driven-development-rdd-a-pragmatic-approach-to-software-development-e7329a82f2d3) | Medianos, con requisitos conocidos | Primero los casos de uso. Después tests del happy path, el núcleo, y al final E2E para los casos malo y peor. |
| **SDD** · Spec Driven Development | Grandes o riesgosos | Exploración, entrevista de arquitectura con ADR, contrato OpenSpec, código y auditoría estricta. |

## Compartir entre agentes

Todo vive en el repo, dentro de `.xjergx/`, y se accede con la CLI `xjergx`. Así funciona igual desde cualquier
herramienta.

| Qué | Fuente única | Cómo llega a cada herramienta |
|---|---|---|
| **Estado de la sesión** | `.xjergx/session.json` (último handoff) y `.xjergx/sessions/` (historial) | `xjergx resume` al empezar; `xjergx handoff` al terminar |
| **Memoria** | [Engram](https://github.com/Gentleman-Programming/engram) si está instalado; si no, `.xjergx/memory/` (proyecto) y `~/.xjergx/memory/` (global) | `xjergx memory search / add / show`, o las herramientas MCP de Engram (`mem_search`, `mem_save`) |
| **Skills** | `.xjergx/skills/<nombre>/SKILL.md` (estándar [Agent Skills](https://agentskills.io)) | `xjergx sync` las copia a `.claude/skills/` y `.agents/skills/` |
| **Agents** | `.xjergx/agents/<nombre>.md` (frontmatter `name` + `description`, cuerpo = prompt) | `xjergx sync` genera `.claude/agents/*.md`, `.codex/agents/*.toml`, `.opencode/agents/*.md` y `.pi/prompts/*.md` |
| **Instrucciones** | `.xjergx/protocol.md` (generado) | Bloque en `AGENTS.md` (Codex, OpenCode, Pi, omp) e import `@.xjergx/protocol.md` en `CLAUDE.md` |

### Cambiar de herramienta a mitad de trabajo

```bash
# En Codex, antes de cerrar (el agente lo hace solo si se lo pedís: "dejá un handoff, sigo en Claude"):
xjergx handoff --agent codex \
  --summary "Core del export CSV listo en src/exports/; falta E2E" \
  --next "E2E para exportación vacía y para 200k filas" \
  --open "¿Se incluyen pedidos cancelados?"

# En Claude Code, al abrir la sesión, el hook SessionStart ejecuta:
xjergx resume --agent claude
```

`resume` muestra:
- el último handoff (quién lo hizo, cuándo, resumen, próximos pasos y preguntas abiertas),
- si alguien siguió trabajando después sin dejar handoff,
- el ticket activo con su fase y sus notas de progreso,
- los cambios sin commitear,
- la memoria reciente y las skills compartidas.

Para que el contexto no se pierda si la sesión se corta a mitad de una fase, cada fase mantiene
`tasks/<ID>/progress-<fase>.md` con lo hecho, lo pendiente y lo que respondió el usuario. El siguiente agente
continúa desde ahí.

**Automático cuando la herramienta tiene hooks:**
- **Claude Code** (`.claude/settings.json`) y **Codex** (`.codex/hooks.json`) ejecutan `resume` al iniciar la
  sesión, y al terminar cada turno guardan un registro de actividad (`activity.json`, ignorado por git).
- En **Codex**, los hooks son experimentales: hay que activar `[features] codex_hooks = true` en `.codex/config.toml`.
- En las demás herramientas, la instrucción en `AGENTS.md` y la skill `xjergx` le indican al agente que corra
  `resume` al empezar y `handoff` antes de terminar.

### Memoria

```bash
xjergx memory add "Exports usan streaming" --type decision --tags exports,csv \
  --body "Más de 200k filas superaban 512MB; usar streamCsv de src/lib/csv.ts"
xjergx memory add "Prefiero pnpm" --type preference --global     # vale para todos tus proyectos
xjergx memory search "csv"
xjergx memory show <id>                                           # id de Engram (#7) o de Markdown (notes/...)
xjergx memory list
xjergx memory backend                                             # engram | markdown, y por qué
```

**Con Engram (recomendado).** Si el binario `engram` está en el PATH, `xjergx memory` escribe y busca ahí:
- Es la misma base que usan los agentes conectados con `engram setup` a través de sus herramientas MCP
  (`mem_search`, `mem_save`, `mem_context`…). Lo que guarda Codex lo encuentra Claude, aunque uno use la CLI y el
  otro MCP.
- Búsqueda full-text en SQLite (FTS5), contexto de sesiones recientes, interfaz de terminal (`engram tui`) y
  [Git Sync](https://github.com/Gentleman-Programming/engram) para llevar la memoria a otra máquina o al equipo.
- Los handoffs también se guardan en Engram, y al cerrar cada ticket su registro (`memory/tasks/<ID>.md`) se indexa
  ahí. `xjergx resume` muestra el contexto reciente de Engram.
- Tipo, tags, agente y ticket van como líneas al inicio del contenido (la CLI de Engram no tiene campos para eso).
  Las memorias `--global` van al proyecto `xjergx-global` de Engram.

**Sin Engram, o si una llamada a Engram falla.** La memoria se guarda en Markdown con frontmatter (`title`, `type`,
`tags`, `agent`, `task`, `created`) en `.xjergx/memory/notes/` o en `~/.xjergx/memory/notes/`. Se versiona con git y
cualquier agente puede leerla sin la CLI. La búsqueda siempre incluye estos archivos, así que nada se pierde al
instalar Engram después.

Los registros de tickets (`memory/tasks/<ID>.md`) siempre quedan en el repo, con o sin Engram. Tipos disponibles:
`decision`, `convention`, `gotcha`, `asset`, `preference`, `note`.

Configuración en `.xjergx/config.json`:

```json
"memory": { "backend": "auto", "engramProject": null, "globalProject": "xjergx-global" }
```

- `backend`: `auto` (Engram si está instalado), `engram` o `markdown`.
- `engramProject`: `null` deja que Engram detecte el proyecto por el directorio, igual que hacen los agentes por MCP.
  Fijalo si tu workspace tiene varios repos.
- La variable de entorno `XJERGX_MEMORY_BACKEND` tiene prioridad sobre la config.

### Exploración de código con codegraph

Si [codegraph](https://github.com/colbymchenry/codegraph) está instalado, o el workspace tiene un índice
`.codegraph/`, los prompts de cada fase le indican al agente cómo usarlo:
- `codegraph_explore` para ubicar código y flujos.
- `codegraph_context` para ver quién llama a un símbolo y el radio de impacto de un cambio.

Lo usan en particular:
- el classifier, para estimar cuántos archivos toca el ticket;
- el explorer, para el análisis de impacto;
- los reviewers, para revisar quién llama al código que cambió.

Según su benchmark, ahorra tokens y llamadas a herramientas, sobre todo en repos grandes. El prompt le pide al agente
correr esas consultas él mismo: si delega la exploración a un subagente que lee archivos, el grafo no se usa. Sin
codegraph, los agentes usan búsqueda de texto como siempre.

Configuración: `"codegraph": "auto" | "on" | "off"` en `.xjergx/config.json`, o la variable `XJERGX_CODEGRAPH`.

### Conectar Engram y codegraph a cada herramienta

```bash
xjergx doctor          # estado de Engram, codegraph y cada herramienta configurada
xjergx doctor --fix    # corre `engram setup <agente>` para claude-code, codex, opencode y pi
codegraph init -i      # interactivo: indexa el workspace y conecta los agentes que elijas
```

`engram setup` no cubre omp, y el instalador de codegraph no cubre Pi ni omp. En esos casos `doctor` te avisa que
agregues el servidor MCP a mano.

### Skills y agents

```bash
# Crear una skill una sola vez…
mkdir -p .xjergx/skills/db-migrations && $EDITOR .xjergx/skills/db-migrations/SKILL.md
xjergx sync                                # …y queda en Claude, Codex, OpenCode, Pi y omp

# ¿Ya la tenías en una herramienta? Adoptala:
xjergx import                              # trae lo de .claude/, .agents/, .codex/, .opencode/, .pi/ a .xjergx/
xjergx sync

# Skills y agents personales (todos tus proyectos): ~/.xjergx/skills y ~/.xjergx/agents
xjergx import --global && xjergx sync --global
```

Destinos de `xjergx sync`:

| Herramienta | Skills | Agents | Instrucciones | Hooks |
|---|---|---|---|---|
| Claude Code | `.claude/skills/` | `.claude/agents/*.md` | `CLAUDE.md` → `@.xjergx/protocol.md`, `/xjergx` | `.claude/settings.json` |
| Codex | `.agents/skills/` | `.codex/agents/*.toml` | `AGENTS.md` | `.codex/hooks.json` |
| OpenCode | `.agents/skills/` | `.opencode/agents/*.md` (subagent) | `AGENTS.md`, `/xjergx` | — |
| Pi | `.agents/skills/` | `.pi/prompts/*.md` (Pi no tiene subagentes: tus agents quedan como `/nombre`) | `AGENTS.md`, `/xjergx` | — |
| omp | `.claude/skills/` | `.claude/agents/*.md` (omp hereda `.claude/`) | `AGENTS.md` | — |

Cómo se comporta `sync`:
- Solo escribe y borra archivos que generó él; esa lista se guarda en `.xjergx/sync-manifest.json`.
- Si encuentra un archivo tuyo con el mismo nombre, no lo pisa: te avisa para que lo adoptes con `import`.
- Si renombrás o borrás una skill, también limpia sus copias.
- En `AGENTS.md` y `CLAUDE.md` solo toca el bloque entre `<!-- xjergx:start -->` y `<!-- xjergx:end -->`.
- En los JSON de hooks solo agrega sus propias entradas; tus permisos y tus hooks se mantienen.

Al convertir un agent de una herramienta, `import` conserva el nombre, la descripción y el prompt.
Los campos propios de cada herramienta (modelo, permisos, `tools`) no se trasladan. Si los necesitás, ajustalos en
la config de esa herramienta.

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
xjergx init      # crea .xjergx/ y genera los archivos de cada herramienta (config.targets)
git add -A && git commit -m "chore: xjergx"
xjergx add "Agregar exportación CSV de pedidos"
xjergx add "Corregir typo en el footer" --lane odd
xjergx status
```

Para generar solo algunas herramientas, editá `targets` en `.xjergx/config.json` o usá
`xjergx sync --target claude --target codex`.

## Dos formas de usarlo con tu agente

### 1. Modo driver: xjergx lanza al agente

```bash
xjergx run --agent claude      # o codex | opencode | pi | omp | manual
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
| omp | `omp "<prompt>"` | `omp -p "<prompt>"` |

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

`xjergx sync` (o `init`) ya dejó en cada herramienta el comando `/xjergx` (Claude Code, OpenCode, Pi), los
subagentes de cada fase y las instrucciones en `AGENTS.md`/`CLAUDE.md`. Dentro del agente usás `/xjergx`, o le pedís
"trabajá el backlog de xjergx". El agente repite `xjergx next --json` y hace lo que indica la respuesta:

| `action` | Qué hace el agente |
|---|---|
| `run_phase` | Ejecuta `promptFile`, o lo delega al subagente indicado en `agent` |
| `approve` | Te muestra el documento. Según tu respuesta corre `xjergx approve` o `xjergx reject --note "..."` |
| `done` / `idle` / `stop` / `blocked` | Termina y te informa |

En los dos modos los prompts son los mismos: un solo lugar de verdad en `agents/` (y tus overrides en
`.xjergx/agents/`). Los subagentes generados para las fases son stubs que leen el archivo de fase, así que no duplican
contenido. Commiteá los archivos generados (el preflight exige un árbol limpio para empezar un ticket).

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
  backlog.json            estado de los tickets (no editar a mano mientras corre)
  config.json             agent, mode, targets, router, adapters
  session.json            último handoff (commitealo: viaja con el repo)
  sessions/               historial de handoffs, uno por archivo
  activity.json           última actividad registrada por los hooks (ignorado por git)
  memory/tasks/<ID>.md    lo que aprendió cada ticket (archivist)
  memory/notes/*.md       memoria escrita por cualquier agente (cuando no se usa Engram)
  skills/<nombre>/        tus skills compartidas (SKILL.md + archivos de apoyo)
  agents/<nombre>.md      tus agents compartidos y overrides de los roles
  protocol.md             instrucciones comunes (generado)
  sync-manifest.json      qué archivos generó `sync` (generado)
  tasks/<ID>/             artefactos del ticket: classification.json, progress-<fase>.md, requirements.md,
                          context.md, adr.md, spec.md, build-report.md, audit.md, history/
  prompts/                instrucciones generadas por fase (ignorado por git)

~/.xjergx/                lo mismo, pero personal: memory/, skills/, agents/
```

## Comandos

```
xjergx init | sync [--target <t>]... [--global] | import [--global] [--force]
xjergx resume [--agent <t>]
xjergx handoff --summary "..." [--next "..."]... [--open "..."]... [--agent <t>]
xjergx memory add "<título>" [--body] [--type] [--tags a,b] [--global] | search "<q>" | list | show <id> | backend
xjergx doctor [--fix] [--target <t>]...
xjergx add | status | lane <ID> <carril>
xjergx run  [--agent] [--mode] [--task] [--step] [--skip-preflight]
xjergx next [--json] [--task] [--mode]
xjergx approve | reject --note "..." | unblock [--phase <fase>]
```

## Migración desde v0.2

- `.xjergx/engram/` se mueve solo a `.xjergx/memory/tasks/` la primera vez que corrés cualquier comando.
- `xjergx install <herramienta>` sigue funcionando como alias de `xjergx sync --target <herramienta>`.
- OpenCode ahora lee `.opencode/agents/` y `.opencode/commands/` (en plural). `sync` borra los archivos viejos que
  había generado `install` en las carpetas en singular.
- Ejecutá `xjergx sync` una vez para generar skills, hooks e instrucciones nuevas, y commiteá el resultado.

### Desde v0.1 (`xjergx.sh`)

Un `backlog.json` existente sigue funcionando sin cambios:
- `type: "hotfix"` pasa al carril ODD.
- Los estados `spec_ready`, `coding` y `archiving` se mapean a las fases SDD equivalentes.
- El `xjergx-hotfixer` lo reemplaza `xjergx-odd-builder`.
- `xjergx-spec-code-review` ahora se llama `xjergx-code-reviewer`.

## Desarrollo

```bash
npm test   # router, máquina de estados, memoria, handoff/resume, sync/import y flujos completos con un agente falso
```
