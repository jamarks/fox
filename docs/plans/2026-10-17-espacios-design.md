# Espacios: carpetas armadas a partir de repos

## Problema

En la Mac, una sesión de fox se abre en una carpeta del disco, elegida con el Finder o escribiendo la ruta. En el VPS no hay Finder ni carpetas preexistentes: el trabajo real vive en repos de GitHub, a veces varios juntos (por ejemplo `orchestra` = `orchestra-backend` + `orchestra-portal` + `orchestra-ops`, más notas y archivos sueltos).

## Decisión

Un **espacio** es una carpeta con nombre, guardada, que contiene uno o varios repos de GitHub clonados como subcarpetas, y que puede tener además cualquier otro archivo. Se crea una vez y se reabre muchas veces. Elegida la variante A del mockup: los espacios en la barra lateral, y "nuevo espacio" en un diálogo.

- **Dos sesiones en el mismo espacio trabajan sobre la misma copia** (decidido por el dueño, por simpleza). fox avisa cuando abrís una sesión en un espacio donde otra está trabajando. Las copias aparte (git worktree) quedan para más adelante y no son parte de este diseño.
- Las carpetas sueltas siguen funcionando: escribir una ruta sigue siendo una opción. El selector del Finder sigue en el modo local.
- Funciona igual en el modo local y en el VPS. En la Mac, los espacios también se clonan en `~/workspaces`.

## Experiencia

**Barra lateral.** La lista de proyectos agrupa las sesiones por espacio, con su nombre y cuántos repos tiene. Las carpetas sueltas siguen apareciendo como hoy. Un `+` al lado del título "Espacios" abre el diálogo.

**Diálogo "Nuevo espacio".**
1. Nombre (por ejemplo `orchestra`). Se valida como nombre de carpeta: `^[a-z0-9][a-z0-9._-]{0,62}$`.
2. Buscador de repos, con la lista agrupada por dueño (`jamarks`, `hiOrchestra`, ...). Muestra solo los repos que ven los tokens del servidor. Selección múltiple con tildes.
3. Pie: "3 repos · se clonan en `~/workspaces/orchestra`" y el botón **Crear y abrir**.
4. Al confirmar: crea la carpeta, clona cada repo (con progreso por repo en el mismo diálogo) y abre el diálogo de nueva sesión ya apuntando al espacio, con el modelo y las herramientas de siempre.
5. Si un repo falla al clonar (sin acceso, red), el espacio se crea igual con los demás y el error queda visible en ese repo, con "Reintentar".

**Editar un espacio.** Desde el menú del espacio en la barra lateral: renombrar la entrada (la carpeta no se mueve), agregar repos (los clona) y quitar repos de la lista. Quitar un repo **no borra su carpeta**: fox solo deja de listarlo.

**Borrar un espacio.** Saca la entrada de fox. Borrar la carpeta es una opción aparte, con confirmación, y solo si ningún repo tiene cambios sin commitear ni commits sin pushear. Si los tiene, fox lo dice y no borra.

**Al abrir una sesión en un espacio** fox corre `git fetch` en cada repo, sin merge ni pull, y muestra el estado por repo: rama, `±` cambios sin commitear, `↑` adelante y `↓` atrás del remoto. Si hay otra sesión de fx trabajando en ese espacio, muestra el aviso.

## Datos

- `~/.config/fox/workspaces.json` (`0600`): `[{ "id", "name", "dir", "repos": [{ "owner", "name" }], "createdAt" }]`. fox nunca escribe en `~/.fx`.
- Carpeta: `~/workspaces/<nombre>/<repo>/`. Si dos repos de distintos dueños se llaman igual, el segundo va como `<repo>-<dueño>`.
- Las sesiones de fx se asocian a un espacio por su `workspace` (la carpeta del espacio o algo debajo), igual que hoy se agrupan por carpeta.

## Implementación

En el código y la UI se llaman **workspaces** (la UI de fox está en inglés). La lógica está en `workspaces.mjs`, con tests en `tests/workspaces.test.mjs`.

## Servidor (`server.mjs`)

- `GET /api/repos`: lista los repos visibles. Usa `gh repo list <dueño> --json nameWithOwner,isPrivate,updatedAt --limit 200` para `jamarks` y para cada dueño con token en `~/.config/fox-git/tokens/`. Pasa por el envoltorio de `gh`, que elige el token. Caché en memoria de 5 minutos, con un refresh explícito.
- `GET /api/workspaces`, `POST /api/workspaces` (nombre + repos), `PATCH /api/workspaces/:id` (renombrar, agregar o quitar repos), `DELETE /api/workspaces/:id` (con `?folder=1` para borrar la carpeta, aplicando las comprobaciones de arriba), `POST /api/workspaces/:id/fetch` y `POST /api/workspaces/:id/retry`.
- El estado por repo (rama, `±`, `↑`, `↓`, clonando o error) viaja en `GET /api/overview` y `GET /api/workspaces`.
- Clonado con `execFile('git', ['clone', '--', url, dir])`, nunca con shell. `url` se arma solo desde `owner` y `name` validados con `^[A-Za-z0-9._-]+$`. Las credenciales las pone el credential helper. Progreso por polling (un clon a la vez por espacio).
- Todos los endpoints nuevos pasan por la misma autenticación, el chequeo de origen y el `sameOrigin` de los POST que el resto de la API.
- Toda ruta resuelta tiene que quedar dentro de `~/workspaces/`. Rechazar cualquier `..`, symlink que salga del árbol o nombre inválido.

## Fuera de alcance

- Copias aparte por sesión (worktrees).
- El buscador unificado (variante B), como atajo de teclado más adelante.
- La tarjeta del espacio con estado completo (variante C) como vista propia. En este diseño el estado por repo aparece al abrir la sesión.
- Crear repos nuevos en GitHub desde fox.

## Tests

- Validación de nombres de espacio, de `owner` y `name`, y rutas fuera de `~/workspaces`.
- Crear un espacio con repos locales de prueba (`git init --bare` como remoto) y verificar los clones y `workspaces.json`.
- Falla parcial de clonado: el espacio queda creado y el error es visible.
- Borrar con cambios sin commitear o sin pushear: se niega.
- Endpoints sin passkey: 401. POST sin el origen correcto: 403.
