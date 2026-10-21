# fox, independiente del harness

Objetivo: fox deja de ser "el panel de fx" y pasa a ser **el panel de tus agentes de código en tu servidor**, sea cual sea el harness: fx, Claude Code y mañana Cursor CLI, Codex, Hermes u otro que todavía no existe. Cada sesión elige su harness al abrirse y todas conviven en el sidebar, la terminal, Read y el panel derecho.

Restricción tan importante como el objetivo: **fox sigue liviano.** Sin dependencias nuevas, sin framework de plugins, sin una UI propia del agente. Agregar un harness tiene que ser un archivo chico, no una rama de `if (harness === …)` en todo el código.

Primer caso concreto: Claude Code, para usar Opus y Sonnet con la suscripción de Claude a costo fijo.

## Estado (2026-10-22)

Hecho: el contrato en `harnesses/` con fx como primer adaptador (la API de fx da lo mismo que antes, comparado contra `main` sobre 65 sesiones reales), y Claude Code en niveles 1–3: elegirlo en el `+`, terminal, estado por pantalla, retomar, Read, archivos y previews, búsqueda, new replies, subagentes (con `meta.json` y su hand-back) y respuesta desde el teléfono. Contrato corto en `docs/harnesses.md`.

Falta: métricas de Claude Code, MCP/Settings por agente (fase 4 del inventario), el estado genérico por actividad de tmux, cargar adaptadores desde `~/.config/fox/harnesses/`, e instalar Claude Code en el servidor (`setup.sh` y login).

## La idea central

Hoy fox **lee el disco de fx** en todos lados: `server.mjs` (`listSessions`, `readEvents`, `sessionFiles`, `terminalActivity`, `createTerminal`), `search.mjs`, `inbox.mjs`, `metrics.mjs`, `models.mjs`, `fxsettings.mjs`, `tools.mjs`, `notes.mjs` y unos 30 textos de `public/app.js` que dicen "fx".

El cambio tiene tres partes:

1. **fox es dueño de su índice de sesiones.** fox lanza cada sesión, así que anota qué harness, qué id del harness, qué carpeta y qué modelo usó. Eso alcanza para el sidebar, la terminal, dormir y retomar, sin entender nada del harness.
2. **Un formato de eventos propio de fox.** Es el que ya arma hoy `readEvents` (`user`, `assistant`, `tool_call`, `tool_result`, `turn_completed`, `interrupted`), escrito como contrato. Read, inbox, búsqueda, métricas y archivos tocados consumen ese formato y nunca un jsonl crudo.
3. **Un adaptador por harness**, que traduce entre el harness y esas dos cosas. Todo lo que sabe de un formato ajeno vive ahí y en ningún otro lado.

### Capacidades graduales

Un harness nuevo no tiene que hacerlo todo para servir. El adaptador declara qué sabe hacer y la UI muestra solo eso.

| Nivel | El adaptador da | fox ofrece |
|---|---|---|
| **1. Terminal** (obligatorio, ~20 líneas) | `id`, `label`, binario, `launch({cwd, model, sessionId})`, `resume(id)` | sidebar desde el índice de fox, terminal, estado genérico, dormir y retomar, pegar desde el teléfono, nueva sesión en un workspace |
| **2. Transcript** | `events(id)` → eventos fox | Read, new replies, búsqueda, métricas, archivos tocados y previews |
| **3. Extras** (cada uno opcional) | `state` (hooks), `subagents(id)`, `usage(id)`, `models()`, `settings` (lista declarativa como `FX_SETTINGS`), `mcp` (agregar y quitar), `instructionsFile`, `auth` (estado y comando de login), `discover()` (sesiones abiertas fuera de fox) | estado exacto, panel de subagentes, tokens, selector de modelo, Settings → <harness>, Tools, notas de fox, login visible, sesiones externas |

Así se pueden probar harnesses nuevos en una tarde en el nivel 1 y subir de nivel solo si se quedan.

### El contrato

```js
// harnesses/<id>.mjs
export default {
  id: 'claude', label: 'Claude Code', bin: 'claude',
  launch: ({ cwd, model, sessionId }) => ['claude', '--session-id', sessionId, ...(model ? ['--model', model] : [])],
  resume: ({ id }) => ['claude', '--resume', id],
  // opcionales
  events: async (id, ctx) => [...],          // formato fox
  state: { hooks: (stateFile) => ({ /* --settings con hooks */ }) , screen: /esc to interrupt/ },
  subagents, usage, models, settings, mcp, instructionsFile: '~/.claude/CLAUDE.md', auth, discover,
};
```

- **El núcleo pone lo pesado:** cache por `mtime` y `size`, rutas seguras, tmux, el índice y la normalización de ids. Así cada adaptador queda en un archivo de entre 50 y 300 líneas.
- **Registro:** `harnesses/` en el repo, más una carpeta opcional `~/.config/fox/harnesses/*.mjs` para probar uno sin tocar fox (un `import()`, nada más). Un harness aparece en la UI solo si su binario está instalado.
- **Ids:** dentro de fox, `<harness>:<id>` en el índice. Las URLs y tmux usan un id corto y seguro que el índice resuelve. Las sesiones de fx que ya existen se migran solas: `fx-<id>` en tmux se sigue aceptando.

### Inventario: cada función de fox y de dónde sale

Todo lo que fox ya hace tiene que seguir andando. Algunas funciones sirven para cualquier harness tal cual; otras dependen de que el adaptador entregue ciertos datos. La regla: **si una función necesita algo del harness, el contrato lo pide de forma explícita y en formato de fox**. Ninguna función lee nombres de herramientas, rutas ni sintaxis de un harness en particular.

**A. Gratis para cualquier harness (viven en tmux, xterm o el navegador)**

| Función | Por qué no depende del harness |
|---|---|
| Copiar (arrastrar → portapapeles) | tmux selecciona y manda OSC 52; fox lo pasa al portapapeles |
| Pegar, hoja de pegado en el teléfono | `term.paste()`: entra como ⌘V al input de cualquier TUI, sin enviar |
| Dictado | inserta texto en el input, no presiona Enter |
| Links clickeables en la terminal | links OSC 8 que tmux deja pasar, más el detector de fox (`localServerLinks`) para direcciones web y `localhost:<puerto>` impresas como texto |
| Soltar archivos | fox guarda el archivo y pega la ruta. Que el harness la convierta en imagen adjunta depende de él: fx y Claude Code lo hacen. El adaptador lo declara (`attachPaths: true`) y fox ajusta el texto del aviso |
| Scroll táctil, tamaño de letra, temas, layout de teléfono, pairing | navegador + tmux |
| Workspaces, gitsync, PRs, apps, memoria, deploy | no tocan al agente |
| Dormir y retomar | tmux + `resume` del adaptador (nivel 1) |

**B. Necesitan el transcript (nivel 2)**

| Función | Qué le pide al adaptador |
|---|---|
| Read (incluida la vista de solo lectura en el teléfono) | eventos fox |
| **Archivos que tocó la sesión (panel derecho), previews, links `/view/`, tabs que se recargan** | cada `tool_call` normalizado trae `effect: 'write' \| 'edit' \| 'read' \| 'shell' \| 'other'` y `path`. El adaptador traduce `write_file` (fx) o `Write` / `Edit` / `NotebookEdit` con `file_path` (Claude Code) a eso. Las rutas que se mencionan en las respuestas (`` `x.html` ``, `[..](x.md)`) se detectan en el núcleo, sobre el texto, así que valen para todos |
| Salidas largas de herramientas (artifact) | `artifact(id, name)` opcional; sin él, Read muestra solo el preview |
| New replies, sonido, aviso | el turno terminado (`turn_completed`) y el texto de la respuesta |
| Búsqueda global, métricas | textos de `user` y `assistant` con fecha |
| Modelo que respondió | `model` en cada evento `assistant` |

**C. Extras (nivel 3), cada uno con su capacidad**

| Función | Capacidad | Si el harness no la tiene |
|---|---|---|
| Subagentes en el panel derecho (fase, tarea, resultado, "its conversation →") | `subagents(id)` → `{ id, name, phase, task, startedAt, outcome }`, y los hijos tienen `events` | no hay sección de subagentes |
| **Follow up / Steer a un subagente** | `followUp({ name, text })` → el texto que se inserta en la terminal del padre (en fx es `Tell <name>: …`), más `steerWhileBusy` para el aviso "applies after the current tool" | no hay botón |
| `needs_input` (pide permiso) | hooks o regex del adaptador | solo `working` / `ready` |
| `external` (abierta fuera de fox) | `live(id)` | no se marca |
| Tokens y costo | `usage(id)` | no se muestran |
| Selector de modelo | `models()` | solo el modelo por defecto del harness |
| Settings → <harness> | lista `settings` declarativa (el formato de `FX_SETTINGS`) | no hay sección |
| Tools (MCP) | `mcp.add / remove / list` | la herramienta no se ofrece para ese harness |
| Notas de fox (previews, apps, jobs) | `instructionsFile` | el harness no se entera de fox |
| Login visible | `auth.status()` y `auth.loginCommand` | se ve "not signed in" si falla al lanzar |
| **Modelo dentro de un job** (`foxjob.py` llama a `fx ask --auto --json`) | `ask` → comando no interactivo (`claude -p --output-format json`), expuesto a los jobs como `fox ask --harness <id>` | ese harness no se puede usar en jobs |
| Teclas de edición de Mac (⌘⌫ → Ctrl-U, ⌥← → Alt-B…) | por defecto las de readline, que entienden fx y Claude Code; el adaptador puede dar otro `keymap` | se usan las de readline |

Textos de la UI: unos 30 lugares de `app.js` dicen "fx" (por ejemplo "fx is working in this session", "fx keeps running", el "fx" sobre cada respuesta en Read). Pasan a usar el `label` del harness de la sesión.

### Estado sin entender al harness

Hoy fox detecta el estado con una regex sobre la pantalla de fx. Eso no escala a N harnesses, así que el estado se resuelve en capas:

1. **Hooks, si el adaptador los da.** Claude Code tiene hooks (`UserPromptSubmit`, `Notification`, `Stop`) que fox pasa por `--settings` solo para esa sesión; escriben `~/.config/fox/state/<id>`. Otros harnesses tienen algo parecido (por ejemplo, `notify` en Codex).
2. **Genérico, para todos:** si tmux vio salida en el pane en los últimos ~2 s, está `working` (los spinners redibujan cada segundo); si no, `ready`. Usa `#{window_activity}` de tmux, sin leer la pantalla.
3. **La regex opcional del adaptador**, solo para `needs_input`.

### Configuración compartida en vez de una por harness

- **Instrucciones:** fox escribe su bloque (previews, apps, jobs) en el `instructionsFile` de cada harness instalado. Como varios leen `AGENTS.md`, muchas veces es el mismo archivo.
- **MCP:** un solo catálogo en `tools.mjs`. Cada adaptador sabe instalarlo en su harness. En Tools, un switch por herramienta y la lista de harnesses donde está.
- **Settings:** el formato declarativo de `fxsettings.mjs` se generaliza, y cada adaptador trae su lista. Settings muestra una sección por harness instalado.
- **Modelos:** `models.mjs` pasa a ser la parte de fx del adaptador de fx. El selector de nueva sesión es harness → modelo.

### Lo que se descartó

- **Manejar los agentes por ACP (Agent Client Protocol)** en vez de tmux. ACP es un protocolo estándar con el que un editor habla con un agente, y varios harnesses lo hablan. Se descartó porque fox tendría que dibujar toda la UI del agente (permisos, diffs, herramientas) y dejaría de ser liviano, y porque el TUI real del harness es justamente lo que fox muestra. Puede volver más adelante como un tipo de adaptador para harnesses sin TUI.
- **Copiar los transcripts a una base de fox.** Sería otra fuente de verdad que se desincroniza. fox lee el disco del harness y cachea en memoria, como hoy.

## Fases

Cada fase se puede usar sola, va a `main` con `npm test` en verde y no rompe las sesiones de fx que ya existen.

### Fase 0: contrato y fx como primer adaptador

- `docs/harnesses.md`: el contrato y el formato de eventos fox, corto.
- `harnesses/fx.mjs` junta lo que hoy está repartido entre `server.mjs`, `models.mjs`, `fxsettings.mjs`, la parte de fx de `tools.mjs` y `notes.mjs`, y el login.
- `sessions.mjs` (núcleo): el índice de fox y la cache.
- `inbox.mjs`, `search.mjs`, `metrics.mjs` y `sessionFiles` leen eventos fox, no `events.jsonl`.
- Las filas de la API llevan `harness`.
- `tool_call` normalizado con `effect` y `path`; el panel de archivos usa eso y no nombres de herramientas de fx.
- Follow up de subagentes, `ask` de los jobs y el keymap pasan por el adaptador de fx.
- **Listo cuando:** fox se ve y anda idéntico, `npm test` pasa, y fuera de `harnesses/` no se menciona `~/.fx`, `events.jsonl`, `write_file` ni `fx ask`. Esto se puede medir con un `grep` en un test. Además, cada fila de las tablas A, B y C del inventario sigue funcionando con fx: es la lista de chequeo.

### Fase 1: un núcleo neutral

- Estado genérico por actividad de tmux, con la regex de fx como `needs_input` de su adaptador.
- Nombres de tmux `fox-<harness>-<id>` (aceptando `fx-` viejos). `idle.mjs` y `killTerminal` dejan de asumir `fx-`.
- Los textos de la UI dicen el nombre del harness de la sesión, no "fx" fijo (unos 30 lugares de `app.js`).
- Carga de `~/.config/fox/harnesses/`.
- **Listo cuando:** un adaptador de prueba de nivel 1 (por ejemplo, `bash` con un prompt) abre, duerme y retoma desde fox. Queda en `tests/`.

### Fase 2: Claude Code, nivel 1 → 3

- **Nivel 1:** `--session-id` (fox elige el id, así que no hay que adivinar qué sesión creó una terminal), `--resume`, `--model opus|sonnet|haiku`, estado con hooks y `auth` con `claude setup-token`.
- **Selector en la hoja de nueva sesión:** harness → modelo. **Antes de construirlo, 3–4 maquetas para elegir**, junto con la marca de harness en el sidebar.
- **Nivel 2:** traducir `~/.claude/projects/<carpeta>/<uuid>.jsonl` a eventos fox. Bloques `tool_use` y `tool_result` → `tool_call`; `stop_reason: end_turn` → `turn_completed`; `Write`, `Edit` y `Read` (con `file_path`) → archivos tocados. Se ignoran `thinking`, `attachment`, `file-history-*` e `isMeta`.
- **Nivel 3:** subagentes desde `<uuid>/subagents/agent-*.jsonl`, tokens sumados de `message.usage` (sin costo en suscripción), MCP con `claude mcp add --scope user`, instrucciones en `~/.claude/CLAUDE.md` y `discover()` para sesiones abiertas fuera de fox.
- Por verificar en esta fase: si Claude Code permite hablarle a un subagente que sigue corriendo (para `followUp`); si no, esa sesión no muestra el botón. `ask` = `claude -p --output-format json`. Que una ruta de imagen pegada se adjunte como imagen.
- Tests con transcripts reales recortados en `tests/fixtures/claude/`.

### Fase 3: probar que es de verdad agnóstico

- Un tercer harness al menos en nivel 1–2 (Codex CLI, Cursor CLI u otro, el que quieras usar). Si para agregarlo hace falta tocar el núcleo, el contrato está mal y se corrige acá.
- Documentar en `docs/harnesses.md` cómo escribir un adaptador, con el de nivel 1 como ejemplo completo.

### Fase 4: servidor y docs

- `setup.sh` ofrece instalar los harnesses que elijas, y el login de cada uno aparece en fox.
- `README.md`, `docs/how-it-works.md` y `AGENTS.md`: fox es un panel para agentes de código; fx es uno de ellos.

## Cómo se mantiene liviano

- Cero dependencias nuevas. Los adaptadores son ESM plano, como el resto.
- El núcleo no crece con cada harness; crece solo cuando el contrato cambia, y eso pasa en la fase 3 o nunca.
- Nada de UI nueva por harness. Settings, Tools y el selector se arman con listas declarativas.
- Lo que un harness no da, no aparece. Nada de pantallas vacías ni "not supported".

## Decisiones abiertas

1. **Permisos de Claude Code en el servidor.** fx corre en `auto`. ¿Claude Code pregunta (lo vemos como `needs_input`), acepta ediciones solo (`acceptEdits`) o tiene todo (`bypassPermissions`)? Podría ser un setting de su adaptador.
2. **Sesiones externas en la Mac.** ¿`discover()` trae todas (incluye las de la app de escritorio de Claude) o solo las de carpetas de fox?
3. **Harness por defecto** al abrir sesión: ¿el último usado o uno fijo?
4. **Nombre en la UI:** ¿"agent" o "harness"? Para el usuario, "agent" probablemente se entiende mejor.

## Riesgos

- Los formatos en disco (el jsonl de Claude Code, el de fx) no son APIs públicas. El parseo vive solo en el adaptador, ignora lo que no conoce y tiene fixtures reales. Si se rompe, se rompe el nivel 2 de ese harness, no fox.
- Las suscripciones (Claude, ChatGPT) son de uso personal. fox en tu servidor, usado por vos, entra en eso.
