# Claude Code como agente en fox

Objetivo: al abrir una sesión nueva elegir **fx o Claude Code**. Las dos conviven en el sidebar, en la terminal, en Read y en el panel derecho. La razón principal: usar Opus y Sonnet con la suscripción de Claude (Max) a costo fijo, al lado de Codex y Grok que ya ofrece fx.

Se hace de a poco: cada fase se puede usar sola, va directo a `main` con `npm test` en verde y no cambia nada para las sesiones de fx.

## Por qué no es solo cambiar el comando

La terminal es lo fácil: tmux no sabe qué programa corre. Lo difícil es lo que fox **lee del disco** de fx: `session.json`, `events.jsonl`, `usage-v2.json`, `subagent/children.json` y `owner.live`. Lo lee en `server.mjs` (`listSessions`, `readEvents`, `sessionFiles`), `search.mjs`, `inbox.mjs` y `metrics.mjs`. Claude Code guarda otra cosa en otro lugar:

| Qué | fx | Claude Code |
|---|---|---|
| Sesiones | `~/.fx/sessions/<id>/` | `~/.claude/projects/<cwd con / → ->/<uuid>.jsonl` |
| Título | `session.json` → `title` | registros `custom-title` / `agent-name` en el jsonl; si no hay, el primer prompt |
| Mensajes | `events.jsonl`, `{event: {user / assistant / tool_call / tool_result / turn_completed}}` | un registro por línea (`type: user / assistant / system / attachment …`) con `message.content` en bloques (`text`, `tool_use`, `tool_result`, `thinking`) |
| Fin de turno | `turn_completed` | assistant con `stop_reason: end_turn` (o `system` con `stopReason`) |
| Modelo | `provider_replay.source.model` | `message.model` en cada assistant |
| Uso | `usage-v2.json` | `message.usage` de cada assistant, hay que sumarlo (con suscripción no hay costo) |
| Subagentes | `subagent/children.json` + `owner.json` | `<uuid>/subagents/agent-*.jsonl` (`isSidechain: true`), ligados al `tool_use` de `Task`/`Agent` del padre |
| Archivos | `write_file` / `edit_file` / `read_file`, `args.path` | `Write` / `Edit` / `Read`, `input.file_path` |
| Resultados grandes | `tool-results/<name>` | `<uuid>/tool-results/` |
| Vivo | `owner.live` con pid | `~/.claude/sessions/<pid>.json` (`sessionId`, `cwd`, `status`) |
| Lanzar | `fx --provider … --model …` | `claude --session-id <uuid> --model <alias>` |
| Retomar | `fx session resume <id>` | `claude --resume <uuid>` |
| Instrucciones personales | `~/.fx/AGENTS.md` | `~/.claude/CLAUDE.md` |
| MCP | `fx mcp add` | `claude mcp add --scope user` |

Ventajas de Claude Code que fx no tiene:

- **`--session-id`:** fox elige el id antes de lanzar, así que no hace falta adivinar qué sesión creó una terminal nueva por carpeta y hora (`listTerminals`).
- **Hooks:** dan el estado exacto en vez de la regex sobre la pantalla.

## Diseño

### Un "agente" detrás de una interfaz

Un módulo por agente, `agents/fx.mjs` y `agents/claude.mjs`, con la misma forma:

```js
{
  id: 'fx' | 'claude',
  label: 'fx' | 'Claude Code',
  available(),                       // ¿está instalado y con sesión iniciada?
  listSessions(),                    // → mismas filas que hoy arma listSessions()
  readEvents(id),                    // → mismo formato que hoy: user / assistant / tool_call / tool_result / turn_completed / interrupted
  touchedFiles(id),                  // → { path, action } para sessionFiles()
  readArtifact(id, name),
  launch({ cwd, model, resume }),    // → comando para tmux (+ id si lo sabe de antemano)
  activity(screen, id),              // → working / ready / needs_input
  models(),
}
```

El navegador no se entera: recibe las mismas filas con un campo nuevo, `agent`. `server.mjs` pregunta a los dos agentes y junta los resultados. Para las rutas `/api/sessions/<id>/…` busca cuál de los dos tiene ese id.

### Terminales

- Prefijo de tmux por agente: `fx-<id>` sigue igual y se agrega `cc-<uuid>`. `idle.mjs` y `killTerminal` aceptan los dos.
- Se guarda `@fox_agent` en la sesión de tmux, junto a `@fx_resume` y `@fx_cwd`.
- Pegar desde el teléfono (`/api/mobile/…`) funciona igual: es tmux.

### Estado vivo con hooks

Al lanzar, fox pasa `--settings` con hooks que solo existen para esa sesión, sin tocar el `settings.json` del usuario:

- `UserPromptSubmit`, `PreToolUse` → `working`
- `Notification` (pide permiso o espera input) → `needs_input`
- `Stop` → `ready`

Cada hook escribe `~/.config/fox/agent-state/<uuid>` con un script mínimo (`bin/fox-hook.mjs`). Si el archivo no existe, se usa una regex de pantalla como respaldo (el spinner de Claude Code, `esc to interrupt`).

`~/.claude/sessions/<pid>.json` ya trae `status`, pero es un archivo interno sin documentar. Sirve para saber si la sesión está viva (`external` cuando corre fuera de fox), no para el estado fino.

### Rendimiento

Los transcripts de Claude Code pesan varios MB por sesión y `/api/overview` se llama seguido. `listSessions` de Claude cachea por `mtime` y `size` de cada jsonl y solo vuelve a parsear lo que cambió (`search.mjs` ya hace lo mismo con fx). Además, por defecto solo lista proyectos cuya carpeta está bajo `~/workspaces` o fue abierta desde fox, para no traer las sesiones de la app de escritorio de Claude en una Mac.

## Fases

### Fase 0: la interfaz, solo con fx

- Mover lo específico de fx (`listSessions`, `readEvents`, `sessionFiles`, `readArtifact`, el comando en `createTerminal`, `terminalActivity`) a `agents/fx.mjs`.
- `server.mjs` usa la lista de agentes (por ahora uno).
- Las filas llevan `agent: 'fx'`.
- **Listo cuando:** `npm test` pasa, fox se ve y anda igual que antes, y hay tests de `agents/fx.mjs` con un `~/.fx/sessions` de prueba.

### Fase 1: abrir sesiones de Claude Code

- `agents/claude.mjs`:
  - `available()` usa `claude --version` y el estado de autenticación.
  - `launch` arma `claude --session-id <uuid nuevo> --model <alias> --settings <hooks>`; al retomar, `claude --resume <uuid> --settings <hooks>`.
  - `listSessions` da título, carpeta, fechas, modelo, primer prompt, cantidad de turnos y si está viva.
- Hooks y `bin/fox-hook.mjs` para el estado.
- La hoja de nueva sesión permite elegir el agente. **Antes de construirla, 3–4 maquetas para elegir.** Si Claude Code no está instalado, no aparece la opción.
- Una marca chica en el sidebar para las sesiones de Claude, también en maquetas.
- Read: por ahora, mensajes del usuario y textos del asistente (sin herramientas).
- **Listo cuando:** desde fox se abre una sesión de Claude en un workspace, se escribe, se ve trabajando y esperando, se cierra la pestaña, se duerme por inactividad y se retoma.

### Fase 2: Read completo, búsqueda e inbox

- `readEvents` traduce los bloques `tool_use` y `tool_result` al formato `tool_call` de fox. Se descartan `thinking`, `attachment`, `file-history-*` y los registros de meta (`isMeta`).
- `touchedFiles` con `Write` / `Edit` / `Read` / `NotebookEdit`, para que el panel derecho y las previews funcionen igual.
- `inbox.mjs` (`latestCompletedReply`), `search.mjs` y `metrics.mjs` reciben el texto ya traducido, no el jsonl crudo.
- **Listo cuando:** una sesión de Claude se lee en Read igual que una de fx, aparece en "new replies" y en la búsqueda, y sus archivos aparecen en el panel.

### Fase 3: subagentes y uso

- Hijos desde `<uuid>/subagents/agent-*.jsonl`: tarea (el prompt del `Task`), fase (corriendo si no hay `tool_result` en el padre) y resultado.
- Uso: tokens sumados por sesión. Sin costo en suscripción.
- **Listo cuando:** el panel derecho muestra los subagentes de una sesión de Claude y se puede abrir cada uno.

### Fase 4: configuración

- `notes.mjs` escribe el mismo bloque de fox también en `~/.claude/CLAUDE.md` (previews, apps, jobs).
- `tools.mjs`: cada herramienta se activa para fx, para Claude o para los dos (`claude mcp add --scope user`).
- Settings: una sección "Claude Code" chica con modelo por defecto, effort y modo de permisos.
- Modelos: alias fijos (`opus`, `sonnet`, `haiku`), sin consultar al CLI.

### Fase 5: servidor y docs

- `setup.sh` instala Claude Code (instalador nativo) si el usuario lo pide.
- Iniciar sesión en el servidor: `claude setup-token` una vez, visible en fox como hoy el login de fx.
- `docs/how-it-works.md`, `README.md` y `AGENTS.md` dicen que hay dos agentes y qué lee fox de cada uno.

## Decisiones abiertas

1. **Permisos.** fx corre en `auto`; Claude Code pregunta antes de editar o ejecutar. ¿En el servidor arrancamos con `--permission-mode acceptEdits`, con `bypassPermissions`, o dejamos que pregunte? (Las preguntas aparecen como `needs_input` en el sidebar.)
2. **Qué sesiones listar en una Mac.** ¿Solo las de carpetas de fox, o todas las de `~/.claude/projects` (incluye las de la app de escritorio)?
3. **¿Agente por defecto** en la hoja de nueva sesión: el último usado, o siempre fx?

## Riesgos

- El formato del jsonl de Claude Code no es una API pública y cambia entre versiones. Por eso el parseo vive solo en `agents/claude.mjs`, es tolerante (ignora tipos desconocidos) y tiene tests con transcripts reales recortados en `tests/fixtures/`.
- La suscripción de Claude es para uso propio. fox en tu servidor, usado por vos, entra en eso. No se comparte la cuenta.
