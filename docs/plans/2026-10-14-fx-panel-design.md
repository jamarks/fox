# fx-panel: diseño

Fecha: 2026-10-14

## Objetivo

Un panel web local para trabajar con la fx CLI: ver todas las sesiones guardadas,
abrir o reanudar una en una terminal embebida, y leer el transcript de cada
conversación con sus llamadas a herramientas y costo.

## Decisiones

- **La CLI real, no libfx.** `createFxTerminal()` de libfx solo corre en navegador
  con WebAssembly, exige API key del AI Gateway y no comparte sesiones con la CLI.
  Abrir el binario `fx` en una pseudo-terminal usa el login de Codex ya configurado
  y las sesiones quedan en `~/.fx/sessions` como siempre.
- **Solo lectura sobre `~/.fx`.** El panel nunca escribe ahí. Quien escribe es fx.
- **Sin framework.** Un proceso Node con `http`, `ws` y `node-pty`. Frontend en
  HTML, CSS y JS planos con xterm.js.

## Arquitectura

```
navegador ── HTTP ──> server.mjs ── lee ──> ~/.fx/sessions/<id>/{session.json, events.jsonl, usage-v2.json}
    │                      │
    └──── WebSocket ───────┴── node-pty ──> fx [session resume <id>]  (cwd = workspace)
```

### API

- `GET /api/sessions` → lista agrupada por workspace: id, título, modelo, proveedor,
  fechas, turnos, tokens, costo, `subagent_child`.
- `GET /api/sessions/:id/events` → eventos normalizados: `user`, `assistant`,
  `tool_call` (+ su `tool_result` unido por `call_id`), `turn_completed`.
- `WS /pty?cwd=<ruta>[&resume=<id>]` → abre `fx` en esa carpeta. Mensajes JSON
  `{type:"input"|"resize"}` hacia el server, bytes crudos hacia el navegador.

### Pantalla

Sidebar (sesiones por proyecto, campo "nueva sesión en carpeta"), centro (pestañas
de terminales), derecha (transcript de la sesión seleccionada, refresco cada 2 s
mientras hay una terminal abierta).

## Fuera de alcance

Editor de código, árbol de archivos, operaciones git, autenticación del panel
(solo escucha en 127.0.0.1).

## Degradación

Si una línea de `events.jsonl` no se puede parsear o tiene un tipo desconocido,
se muestra como texto crudo. Si `usage-v2.json` falta, la sesión se lista sin costo.

## Revisión 2026-10-14 (tarde)

- Terminales sobre tmux: `fx-<id>` por sesión, opciones `@fx_cwd` y `@fx_resume` para
  reconstruir pestañas. El WebSocket hace `tmux attach`; cerrar la pestaña solo
  desconecta. `DELETE /api/terminals/:name` mata la sesión.
- Estados por sesión leídos de `tmux capture-pane`, porque fx escribe `events.jsonl`
  recién al terminar el turno. Heurística: línea con spinner y `(Ns)` = working;
  pregunta de permiso = needs input; prompt visible = ready.
- `/api/overview` devuelve sesiones y terminales fusionadas. El frontend sondea cada 3 s
  siempre, no solo con pestañas abiertas, y notifica transiciones working → ready.
- Interfaz en inglés. Clic en sesión abre o enfoca. Archivar y renombrar en
  `~/.config/fx-panel/state.json`.
