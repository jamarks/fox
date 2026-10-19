# Onboarding: de 0 a fox funcionando en un VPS

Objetivo: que alguien que llega al README de GitHub por primera vez termine con fox andando en su servidor y usándolo desde el teléfono y la laptop, sin leer los planes internos ni adivinar requisitos.

## Definición de producto (decidida 2026-10-19)

fox es la versión open source de "tus agentes en un servidor": **vos elegís el servidor**. Otros productos te dan el servidor como parte de la solución; acá es tuyo. Un VPS o una máquina en tu casa (home server) son el mismo caso: Cloudflare Tunnel y Tailscale salen hacia afuera, así que funcionan detrás de un router sin abrir puertos.

- **Servidor:** Linux (Ubuntu/Debian) es el camino principal. Una Mac prendida también sirve (fox nació ahí). Windows solo con WSL2 (fox necesita tmux).
- **Desde dónde se usa:** cualquier sistema con un browser con passkeys (Windows, Linux, Mac, teléfono). El sistema del cliente no importa.
- Ya no hay un "modo Mac" separado en el README: correr fox en tu laptop es un servidor más, para probarlo.

## Cómo se probó (2026-10-19)

Ubuntu 24.04 limpio en Docker (como un VPS recién creado), usuario sin sudo, siguiendo el README al pie de la letra: `curl -fsSL .../release/setup.sh | bash`. Además se leyó todo el recorrido del README, `setup.sh`, `bin/fox.mjs` y `docs/plans/2026-10-16-cloud-only-hetzner.md`.

## Lo que encuentra un usuario nuevo

### Bloqueantes (no llega a ver fox)

1. **`fox` no hace nada cuando se instala con `npm -g`, en cualquier sistema.** `bin/fox.mjs` solo arranca si `resolve(process.argv[1])` es igual a la ruta del módulo, pero npm instala `fox` como symlink y `resolve` no sigue symlinks. Sale con código 0 y sin imprimir nada. Reproducido en Linux y en macOS. Como `setup.sh` termina con `exec fox`, **el one-liner del README nunca abrió fox**. Los tests prueban `runFox()`, no el arranque por el symlink.
2. **`setup.sh` en Ubuntu falla cuatro veces seguidas**, cada una con un mensaje distinto:
   - Node no está: sugiere `brew install node`.
   - tmux no está: solo ofrece instalarlo con Homebrew.
   - `npm install -g` con el Node del sistema (el que recomienda nuestro propio plan, NodeSource): `EACCES` en `/usr/lib/node_modules`.
   - `node-pty` no trae binarios para Linux (solo darwin y win32): compila, y sin `build-essential` y `python3` falla con `gyp ERR!`.
3. **Aunque instale, en un VPS no se puede usar.** fox escucha en `127.0.0.1` y `fox` intenta abrir un browser (`xdg-open` no existe). Lo que falta (dominio, Cloudflare Tunnel, Access, passkey remoto, systemd, tmux como servicio) está en un handoff en español con `jwass.xyz` adentro, y **varias piezas no están en el repo**: `fox-update`, las unidades `fox.service` / `fox-tmux.service` / `fox-jobs.service`, la config de cloudflared, `fox-git-credential` y el wrapper de `gh`. Hoy nadie más puede reproducir el servidor.

### Confusos (llega, pero se traba)

4. **El README cuenta otra historia.** Dice "A tiny local cockpit", "Nothing leaves your machine", y el modo VPS figura como "opt-in and not a deployment recipe". La historia real es: un servidor tuyo, usado desde cualquier dispositivo.
5. **fx sin login es invisible.** En un servidor nuevo `fx status` dice `auth=missing`, pero fox no lo muestra. Peor: si se abre "New session" antes de loguear fx, fox guarda una lista de modelos vacía en `~/.config/fox/models.json` y no la vuelve a pedir nunca (`/api/models/refresh` existe pero la UI no lo llama). Es el punto 3 pendiente del plan del VPS.
6. **`fx login codex` en un VPS** necesita `ssh -L 1455:localhost:1455`; solo está documentado en el plan interno.
7. **Grok no aparece**: fx soporta `vercel | codex | grok`, fox solo detecta codex y gateway.

## Qué es obligatorio y qué no

| Requisito | | Por qué |
|---|---|---|
| Un servidor: VPS o home server Linux (Ubuntu 24.04, 4 GB mínimo, 8 GB cómodo) | **Obligatorio** | fox y las sesiones de fx corren ahí, 24/7. |
| Una forma de entrar desde afuera: dominio en Cloudflare (Tunnel + Access, gratis) **o** Tailscale | **Obligatorio uno** | Cloudflare: URL pública protegida. Tailscale: sin dominio, solo tus dispositivos. |
| **Un** proveedor de modelos para fx | **Obligatorio** | Sin esto fox abre terminales que no responden. |
| ↳ ChatGPT (Plus/Pro) vía `fx login codex` | Recomendado | Costo fijo, el que se usa hoy. |
| ↳ Vercel AI Gateway (API key con tope de gasto) | Alternativa | Pago por uso; **necesario para subagentes en modelos de varias marcas**, la función estrella del README. |
| ↳ Grok | Alternativa | fx lo soporta; fox todavía no lo detecta (punto 7). |
| Cuenta de GitHub + `gh auth login` (token fine-grained) | Recomendado | Workspaces desde tus repos, PRs, jobs con `propose_change`. Sin él: se escribe la ruta de una carpeta y se trabaja igual. |
| Un dispositivo con passkeys (iCloud Keychain, 1Password, Google) | **Obligatorio** | El login de fox es solo passkey. |

Sobre codex: **no es obligatorio codex en sí, es obligatorio un proveedor**. Propongo presentarlo como "conectá un proveedor; recomendado: ChatGPT" y explicar que la comparación de modelos necesita el Gateway.

## Plan

### Fase 0 · Bugs que bloquean (chico, primero)

1. `bin/fox.mjs`: comparar con `realpathSync(process.argv[1])`. Test nuevo que arranca `fox` a través de un symlink.
2. `setup.sh` en Linux:
   - detectar `apt` y ofrecer instalar `tmux`, `build-essential`, `python3` (con `sudo`, preguntando);
   - si el prefijo global de npm no es escribible, usar `~/.local` y avisar si no está en `PATH`;
   - sin pantalla (`$DISPLAY` vacío o sesión SSH) no hacer `exec fox`: imprimir los pasos siguientes (ver Fase 2) en vez de intentar abrir un browser.
3. Modelos: refrescar el caché si tiene más de unos minutos o si cambió `connected_providers`, conservar el último bueno si falla. Detectar grok.
4. Si `fx status` dice `auth=missing`, una línea en el panel ("fx is not signed in to a model provider") con el comando para resolverlo. Nada más de UI en esta fase.

### Fase 1 · README con un solo camino claro

Estructura propuesta, en este orden:

1. Qué es, en dos líneas: tu servidor de agentes fx, usado desde cualquier dispositivo. Captura.
2. **What you need**: la tabla de requisitos de arriba, corta.
3. **Set up on a VPS** (recomendado): 5 pasos numerados que remiten a `docs/vps.md`.
4. **Try it on your Mac**: el one-liner actual, presentado como la forma de probarlo en 2 minutos.
5. Después: subagentes, tools, jobs, workspaces, teclado, cómo funciona. La lista larga de "What it does" se recorta.

Además: sacar "Nothing leaves your machine" (vale solo para el modo local, y aun así los prompts van al proveedor) y mover las secciones de Tailscale / pairing por QR a un `docs/mac-remote.md`.

### Fase 2 · Servidor reproducible

1. `deploy/` en el repo, sin secretos y sin dominios propios: `fox.service`, `fox-tmux.service` (usuario), `fox-jobs.service`, `fox-update` (plantilla), `cloudflared.yml.example`, `fox-git-credential`, `fox-git-token`, el wrapper de `gh`, `fox.env.example`.
   - `fox-update` sigue instalándose a mano como root: estar en el repo no lo hace desplegable, así que se mantiene la razón de seguridad original (el agente no cambia un script que corre como root).
2. `docs/vps.md` en inglés: el plan de Hetzner convertido en guía genérica, en el orden en que se hace, con qué hace la persona (cuentas, tokens, logins) y qué hace el script.
3. `setup-vps.sh` (como root, idempotente, sin manejar secretos): usuarios `admin` / `fox` / `foxbuild`, sshd, ufw, metadata bloqueada, Node 22, tmux, build tools, fx para `fox`, fox vía `fox-update`, servicios. Se detiene y explica cuando le toca a la persona: `cloudflared tunnel login`, crear la app de Access, `fx login codex` (con el `ssh -L` exacto), `gh auth login`, `fox-enroll`. Al final imprime el código de alta y la URL.

### Fase 3 · Onboarding dentro de fox (después de la Fase 2)

- La primera vez después del passkey, un checklist mínimo que desaparece cuando está completo: proveedor de fx ✓/✗, GitHub ✓/—, herramientas (opcional). Cada ítem dice el comando exacto. Mostrar 3–4 mockups antes de construirlo.
- `fx login codex` sin túnel SSH (proxy del callback): sigue siendo el trabajo de seguridad aparte que describe el plan del VPS, no un requisito de este hito.

### Fase 4 · Que no se vuelva a romper

- GitHub Action en `ubuntu-latest`: correr `setup.sh` con `FOX_NO_START=1`, arrancar `fox` en un contenedor limpio y comprobar que `/` devuelve `<title>fox</title>` o la página de alta. Habría atrapado los bugs 1 y 2.
- Una prueba real de punta a punta en un VPS nuevo y barato (CX23, ~€5, lo crea la persona), siguiendo solo `docs/vps.md`, cronometrada. Criterio de cierre: de cero a terminal en el teléfono en menos de 30 minutos sin abrir `docs/plans/`.

## Decisiones (2026-10-19)

1. **Entrada:** Cloudflare (dominio) y Tailscale (sin dominio), las dos documentadas. Con Tailscale hay que probar el passkey remoto con `FOX_PUBLIC_ORIGIN` en el nombre `*.ts.net`.
2. **Proveedor:** uno obligatorio: Codex (suscripción de ChatGPT), Vercel AI Gateway (pago por uso, necesario para mezclar marcas) o Grok.
3. **Sin "modo Mac"** en el README: un solo producto, tu servidor.
4. **Instalación del servidor:** one-liner `curl | bash` fijado a `release` como camino principal; clonar y correr el script, como alternativa documentada.
5. **Fase 4 sin VPS:** una máquina Ubuntu de OrbStack (systemd completo, como un VPS recién creado) para la prueba de punta a punta, y GitHub Actions `ubuntu-latest` como test automático. Lo único que no se emula es el dominio real y el passkey en el teléfono.

## Estado

- **Fase 0, hecha (2026-10-19):** `fox` arranca a través del symlink de npm (test nuevo), avisa en vez de buscar un browser en una máquina sin pantalla; `setup.sh` instala con apt Node 22, tmux y las herramientas de compilación, e instala en `~/.local` si la carpeta global de npm es de root; la lista de modelos se vuelve a pedir cuando cambian los proveedores conectados (`models.mjs`) e incluye Grok; el diálogo de nueva sesión avisa si fx no tiene proveedor.
