# fox solo nube en un VPS (Hetzner)

Handoff para el agente que lo implemente. Primero las decisiones tomadas y por qué; después los pasos, lo que hay que verificar y lo que no hay que hacer.

## Decisiones tomadas

1. **Objetivo:** fox corre solo en la nube, sin nada local, y se usa desde cualquier dispositivo (teléfono, laptop, otro browser) sin Tailscale ni el pairing por QR.
2. **Una persona por VPS.** Este fox es solo del dueño.
3. **Dónde:** Hetzner, Ubuntu 24.04, **CX33 (4 vCPU, 8 GB, 80 GB) en Europa**: €8,49/mes más unos €0,50 de IPv4, sin IVA, según los precios oficiales posteriores al ajuste del 15 de junio de 2026. El dueño está en Europa: elegir la ubicación más cercana (Falkenstein, Núremberg o Helsinki). 8 GB porque dos agentes, más Chromium de Playwright, más un dev server no entran en 4 GB; medir con carga real y ajustar. Si alcanzara con 4 GB, el CX23 sale €5,49. Los planes CX y CAX **no existen en EE. UU. ni en Singapur**: allá lo más barato con 8 GB es el CCX13, a unos USD 51/mes. Cualquier VPS con Ubuntu sirve igual.
4. **Descartados por ahora:**
   - **Vercel Sandbox.** Las sesiones duran como máximo 24 h en Pro (45 min en Hobby). Al apagarse se guarda solo el disco, no los procesos (tmux y fx mueren). No se apaga solo por inactividad, así que fox tendría que dormirlo y despertarlo, y las URLs públicas no tienen login. Queda como posible demo futura para llamar la atención de Vercel, no como base.
   - **El enfoque de pi sobre Cloudflare Durable Objects.** Sirve cuando el loop del agente es tuyo. fox envuelve el binario de fx, que necesita una máquina real.
   - **Exponer un puerto con Caddy.** Es válido, pero se prefiere el túnel para no abrir ningún puerto web.
5. **Entrada, con dos candados y ningún puerto web entrante en el VPS.** SSH (22) sigue abierto para administrar; si se puede, restringirlo por IP. El hostname es públicamente resoluble: no tratar la URL como secreto.
   - **Cloudflare Tunnel con nombre** (`cloudflared` como servicio en el VPS, conexión saliente). No es el Quick Tunnel que usa `tunnel.mjs`.
   - **Cloudflare Access** delante del hostname: login por mail o Google, solo para el dueño, con **sesión de 30 días**. Es el primer candado y frena a cualquiera antes de que llegue a fox. **Decidido por el dueño:** se acepta un login extra de Cloudflare más o menos una vez por mes por dispositivo, a cambio de que el passkey de fox (código nuevo, sin auditar) no sea la única barrera frente a internet.
   - **El passkey remoto de fox** (`FOX_PUBLIC_ORIGIN`, ya implementado en el commit 62a646e; ver `docs/plans/2026-10-16-remote-passkey-design.md`). Es el segundo candado y el login del día a día.
   - **Aceptado:** el TLS termina en Cloudflare, así que Cloudflare puede ver en texto plano la terminal, el código y lo que se escriba. Está bien para uso personal. Si algún día hay requisitos de compliance, hay que revisarlo.
6. **Dos usuarios Linux:** `admin`, con sudo, para administrar; y `fox`, **sin sudo**, donde corren fox, tmux, fx, los repos y las sesiones. fx ejecuta comandos que escribe un modelo: si `fox` tuviera sudo, un prompt injection sería root.
7. **Login de fx:** API key del Vercel AI Gateway (`fx setup`) **con límite de gasto**. **Verificado:** el login con suscripción de ChatGPT también funciona. `fx login codex` espera la respuesta en `localhost:1455` del servidor, así que se corre con un túnel SSH desde la Mac: `ssh -t -L 1455:localhost:1455 fox@<ip> 'bash -lc "fx login codex"'`, y se abre el link en el browser de la Mac. Sin `-L`, el browser redirige al localhost de la Mac y el login no termina. Nunca copiar la URL de callback a mano: lleva un código de autorización.
8. **Actualizaciones automáticas desde la rama `release`, con rollback.** fox está en desarrollo y cambia seguido, y en modo solo nube es la única puerta de entrada: si una actualización lo rompe, solo queda SSH. Por eso el servidor **no sigue `main`**: se desarrolla en `main` y, cuando algo está probado, se avanza `release`. El VPS busca los cambios con un timer (pull); GitHub nunca entra al servidor, así que no hay claves del VPS en GitHub. Si la versión nueva no pasa los tests o el chequeo de salud, vuelve sola a la anterior. Detalle en el paso 10.
9. **El modo local sigue existiendo y no se toca.** `FOX_PUBLIC_ORIGIN` ya se niega a combinarse con `FOX_SHARE_PORT`, `FOX_MOBILE_PORT` y `FOX_AUTH_DISABLED`; el pairing y Tailscale quedan para el modo local.

## Lo que ya existe en el código

- `FOX_PUBLIC_ORIGIN=https://fox.<dominio>`: chequea exactamente Host y Origin en los requests y en los WebSocket, usa cookies `Secure; HttpOnly; SameSite=Strict` y fija el rpID de WebAuthn al dominio. Sigue escuchando solo en `127.0.0.1:4848`.
- `node bin/fox-enroll.mjs`: genera un código de un solo uso (10 min, 43 caracteres aleatorios) para registrar el primer passkey. Se corre por SSH.
- Las páginas de `/view/` corren con CSP `sandbox` (origen opaco): no pueden llamar a la API de fox ni abrir terminales. Su token funciona como llave y vence a las 2 h.
- Los requisitos de infraestructura están en el README (sección del modo VPS con passkey) y el plan del passkey remoto los lista.

## Lo que hace la persona, no el agente

El agente **no** crea cuentas, no compra, no ingresa contraseñas ni tarjetas y no pega API keys en el chat. Esto lo hace la persona:

1. Crear la cuenta de Hetzner y el servidor (CX33, Ubuntu 24.04, ubicación europea más cercana) con su clave SSH pública. Pasarle al agente la IP. **No poner secretos en el cloud-init / user-data**: el servicio de metadata los expone a cualquier proceso del VPS.
2. Tener un dominio con el DNS en Cloudflare y activar Cloudflare Zero Trust (plan gratis). Decidir el hostname, por ejemplo `fox.<dominio>`.
3. Correr `cloudflared tunnel login` en el VPS cuando el agente lo pida: abre un link que hay que autorizar en el browser.
4. Crear la API key del AI Gateway **con un límite de gasto** y cargarla con `fx setup` como usuario `fox`, por SSH, sin pasarla por el chat.
5. Si fx tiene que hacer push a GitHub: un **token fine-grained limitado a los repos necesarios**, o una deploy key por repo. Nunca un token clásico con acceso a toda la cuenta.

## Pasos para el agente

### 1. Endurecer el servidor
- Crear el usuario `admin` con sudo y clave SSH. Verificar el acceso en otra sesión **antes** de tocar sshd.
- `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`. Reiniciar sshd.
- Crear el usuario `fox` **sin sudo**, con HOME `0700`. Si la persona necesita entrar como `fox` por SSH, usar su clave; si no, operar con `sudo -u fox -H` desde `admin`.
- `ufw`: denegar todo lo entrante salvo 22/tcp (restringido por IP si se puede). Nada más: el túnel es saliente.
- `unattended-upgrades` activado, **con `Unattended-Upgrade::Automatic-Reboot "false";`**. Un reinicio automático mata todas las sesiones a mitad de una tarea. Los reinicios por kernel se hacen a mano, avisando.
- Bloquear el servicio de metadata para el usuario `fox`: `iptables -A OUTPUT -m owner --uid-owner fox -d 169.254.169.254 -j REJECT`, persistido con `iptables-persistent` o la config de ufw.
- fail2ban es opcional.

### 2. Dependencias
- Como `admin`: Node 22 LTS desde NodeSource (no nvm, para que `/usr/bin/node` sirva a los servicios), `tmux`, `git`, `build-essential` y `python3` (los necesita `node-pty`).
- Como `fox`: fx con `curl -fsSL https://fx.sh/setup.sh | bash`. **Verificar que fx soporte Linux x64**; si no, parar y avisar.
- Que la persona corra `fx setup` como `fox` (paso 4 de la sección anterior). Comprobar con `fx status` y `fx doctor`.
- Para el navegador de fx (Playwright MCP): instalar las dependencias de Chromium (`npx playwright install-deps chromium` como `admin`).

### 3. fox y tmux como servicios
- Código de fox en **`/opt/fox`, propiedad de root y de solo lectura para `fox`**, con una carpeta por versión y un symlink a la activa (ver paso 10): `/opt/fox/releases/<commit>/` y `/opt/fox/current`. Así un agente no puede modificar el fox que lo controla, y volver atrás es cambiar el symlink, sin reconstruir nada. La primera versión se instala con el mismo script de actualización del paso 10.
- **tmux en su propio servicio, separado de fox.** Si fox lanza tmux como hijo, reiniciar fox puede matar todas las sesiones. `KillMode=process` lo evita, pero systemd lo desaconseja. Lo recomendado:
  - `loginctl enable-linger fox`.
  - Un servicio de usuario `~fox/.config/systemd/user/fox-tmux.service` que mantenga vivo el servidor de tmux (por ejemplo `tmux -D` con un socket fijo), con `Restart=always`.
  - **El socket de tmux en el HOME:** `TMUX_TMPDIR=/home/fox/.tmux` (directorio `0700`), igual para el servicio de tmux y para fox. Así no depende de `/tmp` y se puede usar `PrivateTmp` en fox.
  - Verificar que fox crea sus sesiones `fx-*` en ese servidor de tmux y que `systemctl restart fox` no las toca.
  - Si este diseño no funciona, volver a `KillMode=process` en fox y documentar por qué.
- Unidad `/etc/systemd/system/fox.service`:

```ini
[Unit]
Description=fox
After=network-online.target

[Service]
User=fox
WorkingDirectory=/opt/fox/current
Environment=FOX_PUBLIC_ORIGIN=https://fox.<dominio>
Environment=PORT=4848
Environment=TMUX_TMPDIR=/home/fox/.tmux
ExecStart=/usr/bin/node /opt/fox/current/server.mjs
Restart=always
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

- Nunca arrancar con `fox` (el CLI intenta abrir un browser local). `%h` no sirve para el HOME en servicios de sistema (apunta a `/root`): usar rutas explícitas.
- Límites para que un agente desbocado no tire el servidor: `MemoryMax` y `TasksMax` en el servicio de tmux (ahí corren los agentes), con valores elegidos después de medir.

### 4. Cloudflare Tunnel
- Instalar `cloudflared` desde el repo apt oficial de Cloudflare.
- **Configurar primero Access (paso 5)** y recién después crear la ruta DNS, para que nunca haya una ventana sin login.
- La persona corre `cloudflared tunnel login`. Después: `cloudflared tunnel create fox` y `cloudflared tunnel route dns fox fox.<dominio>`.
- `/etc/cloudflared/config.yml`: ingress `fox.<dominio>` → `http://127.0.0.1:4848` y una regla final `http_status:404`. Instalar como servicio con `cloudflared service install`.
- **Credenciales del túnel:** definir y documentar bajo qué usuario corren `tunnel login`, `tunnel create` y el servicio. Comprobar la ruta efectiva del certificado (`cert.pem`), del JSON de credenciales del túnel y de `config.yml`, con permisos mínimos que el servicio pueda leer y **fuera del alcance de `fox`**. Nunca copiar estos archivos al repo ni imprimirlos en logs.
- Probar que `systemctl restart cloudflared` y un reinicio del VPS levantan el túnel sin intervención humana.
- **Verificar que el Host que le llega a fox sea `fox.<dominio>`** y que el header Origin pase intacto. fox rechaza cualquier otro valor, y eso es lo que tiene que pasar.

### 5. Cloudflare Access
- Zero Trust → Access → Applications → Self-hosted, con el hostname `fox.<dominio>`.
- Política: Allow, que incluya solo el mail del dueño. Método: one-time PIN por mail o Google.
- Duración de sesión: **30 días** (decidido). Confirmar que, al vencer, la terminal se reconecta después de volver a loguearse y no queda colgada.

### 6. Registrar el passkey
- Desde `admin`: `cd /opt/fox/current && sudo -u fox -H env FOX_PUBLIC_ORIGIN=https://fox.<dominio> node bin/fox-enroll.mjs`.
- La persona abre `https://fox.<dominio>`, pasa Access, escribe el código y crea el passkey. Conviene registrarlo en un gestor que sincronice (iCloud Keychain o 1Password) para que funcione en el teléfono y en la laptop.
- No copiar el `~/.config/fox/passkey.json` de la Mac: el de localhost no sirve en el dominio, y fox se niega a arrancar si lo encuentra.

### 7. Verificación (todo tiene que pasar antes de usarlo en serio)
- Sin sesión de Access, **ninguna petición llega a fox**: puede ser una redirección, un desafío o un rechazo según la configuración real. Confirmarlo en los logs de fox, no solo por la respuesta de `curl`.
- Desde afuera, en la IP del VPS, 80, 443 y 4848 no responden (`nmap -p 22,80,443,4848 <ip>`), y 22 sí permite administrar.
- Con Access y sin passkey: la API y el WebSocket `/pty` responden 401 o 403.
- El flujo completo en un browser real, en laptop y teléfono: Access, passkey, panel, terminal en vivo, escribir en fx, dictado.
- Como `fox`: no tiene sudo, no puede escribir en `/opt/fox`, no llega a `169.254.169.254` y no puede leer las credenciales de cloudflared.
- `sudo systemctl restart fox` → las sesiones de tmux y fx siguen vivas y se reconectan.
- Reiniciar el VPS → fox, tmux y cloudflared vuelven solos. Las sesiones de fx mueren; comprobar que `fx session resume <id>` (o abrirla desde fox) retoma la conversación.
- Actualización: avanzar `release` con un cambio inocuo → el servidor lo toma solo, sin cortar sesiones de fx. Después, avanzar `release` con un commit que rompa el arranque a propósito → el script vuelve a la versión anterior, fox sigue respondiendo y llega la alerta. Al terminar, avanzar `release` con el revert de ese commit (fast-forward, sin force push) y comprobar que se despliega.
- Dos agentes trabajando a la vez, uno con el navegador de Playwright: medir RAM, CPU y swap, y ajustar el tamaño del VPS y los límites del paso 3.

### 8. Cambios en fox para el modo nube
Detectar el modo con `FOX_PUBLIC_ORIGIN`, o con `process.platform !== 'darwin'` cuando sea algo específico de macOS. En orden de prioridad:
1. **Ver los dev servers: hecho.**
   - Cada puerto de una lista fija tiene su hostname de primer nivel: `fox-3000`, `fox-3001`, `fox-4321`, `fox-5173`, `fox-8000` y `fox-8080` en `jwass.xyz` (cubiertos por el certificado universal gratis). El túnel los manda a `127.0.0.1:<puerto>` con `originRequest.httpHostHeader: localhost`, porque Vite y otros dev servers rechazan hosts desconocidos.
   - **Una app de Access por hostname**, todas con la policy reutilizable `solo yo` y sesión de 730 h. No se ponen varios hostnames en una sola app: Access pasa por todos al loguearse para dejar la cookie, y si uno falla (por ejemplo, un caché de DNS negativo en la máquina del usuario, que dura 1800 s en esta zona) se rompe el login de todos. Se aprendió en el primer intento. Al agregar hostnames: **crear primero las apps de Access, después las rutas DNS**, y nunca sacar un hostname de una app antes de que exista la nueva.
   - Por qué un hostname y no un puerto o una ruta dentro de `fox.<dominio>`: Cloudflare solo proxea algunos puertos, y las cookies no se separan por puerto, así que el dev server (código que escribió un agente) recibiría la cookie de sesión de fox. La cookie `fox_session` es host-only y no llega a `fox-<puerto>`.
   - fox: `FOX_PREVIEW_URL=https://fox-{port}.jwass.xyz` y `FOX_PREVIEW_PORTS=3000,3001,4321,5173,8000,8080` en `/etc/fox/fox.env`. `/api/config` se lo pasa a la página, y la terminal convierte `http://localhost:<puerto>/...` en un link al preview (en el modo local, abre la URL tal cual).
   - **Verificado** con Vite 8: la página carga detrás de Access y el hot reload (WebSocket) funciona por el túnel sin configuración extra.
   - Pendiente: Next.js puede pedir `allowedDevOrigins` para el origen del preview. Sumar un puerto nuevo es: app de Access, ingress, ruta DNS y agregarlo a `FOX_PREVIEW_PORTS`.
2. **Logins con callback a localhost** (visto en el primer uso real). `fx login codex` (puerto 1455) y `fx mcp auth vercel` (puerto al azar, por ejemplo 35991) redirigen el browser a `localhost` del servidor, y el browser del usuario los manda a su propia máquina. Hoy se resuelve a mano con `ssh -L <puerto>:127.0.0.1:<puerto>`. fox debería resolverlo solo: detectar el puerto del `redirect_uri` y reenviar el callback (por ejemplo, una ruta `/callback/<puerto>/...` detrás del passkey que solo acepte puertos de un login que fox mismo lanzó). Nunca pedirle al usuario que copie la URL de callback: lleva un código de autorización.
3. **Caché de modelos desactualizado.** fox guarda la lista de proveedores y modelos en `~/.config/fox/models.json` y no la refresca cuando se conecta un proveedor nuevo: después de `fx login codex`, el diálogo seguía mostrando solo "fx default". Invalidar el caché cuando cambia `connected_providers` en `fx status`, o refrescarlo al abrir el diálogo si tiene más de unos minutos.
4. **Nuevo proyecto desde una URL de git**: "clonar y abrir fx ahí". En la nube no hay carpetas locales que elegir.
5. **Selector de carpeta nativo** (`/api/pick-folder`, cerca de la línea 532) usa osascript. En modo nube: escribir la ruta, o un explorador de carpetas simple del lado del servidor dentro de `$HOME`.
6. **Abrir un archivo con ↗** (`server.mjs`, cerca de la línea 431) hoy responde 501 fuera de macOS. En modo nube: ocultar el botón o reemplazarlo por una descarga.
7. **Retomar al arrancar:** si fox arranca y no hay sesiones de tmux (por ejemplo después de un reboot), ofrecer reabrir las que estaban abiertas con `fx session resume`.
8. **Validar el JWT de Access** (`Cf-Access-Jwt-Assertion`, contra los certificados del team de Cloudflare). Opcional con una sola persona, pero suma defensa: fox rechaza cualquier request que no haya pasado por Access, incluso desde el propio VPS.
9. **README:** sección "Cloud mode" con este recorrido. El README hoy promete "Nothing leaves your machine": ajustarlo para que ese sea el modo local.
10. **`setup-vps.sh`** (opcional): automatizar los pasos 1 a 4, idempotente y sin manejar secretos.

### 9. Operación
- **Backups:** activar los backups de Hetzner (+20% del precio) o correr `restic` sobre `/home/fox` (repos, `~/.fx` y `~/.config/fox`) hacia un bucket cifrado. El passkey vive en `~/.config/fox/passkey.json`.
- **Monitoreo mínimo:** una alerta si el disco pasa el 80% y si fox, tmux o cloudflared se caen. Por ejemplo, un healthcheck externo (Healthchecks.io, gratis) alimentado por un timer de systemd.
- **Actualizar fox:** automático desde `release` (paso 10). Para forzar una actualización o un rollback a mano: `sudo /usr/local/sbin/fox-update` o `sudo /usr/local/sbin/fox-update --rollback`.

### 10. Actualizaciones automáticas desde `release`
**Flujo de desarrollo:** se trabaja en `main`. Cuando una versión está probada, se avanza `release` con fast-forward (`git push origin main:release`, o un commit concreto: `git push origin <commit>:release`). Nunca se reescribe `release` con force push.

**Lo que hace la persona:** crear la rama `release` en GitHub desde el último commit sano de `main`. Opcional: protegerla para que solo acepte fast-forward.

**Usuarios y archivos:**
- `foxbuild`: usuario de sistema sin login y sin sudo. Es el único que corre `npm ci` y `npm test`, porque los scripts de instalación de npm (node-pty) ejecutan código del repo. Nunca correrlos como root.
- `/opt/fox/releases/<commit>/`: una carpeta por versión. La arma `foxbuild` en un directorio temporal; cuando pasa los tests, root la mueve acá y la deja `root:root` y de solo lectura para `fox`.
- `/opt/fox/current`: symlink a la versión activa. `/opt/fox/previous`: symlink a la anterior.
- `/usr/local/sbin/fox-update`: el script, `root:root`, `0755`. Lo corre `fox-update.timer` cada 10 minutos.

**Qué hace `fox-update`:**
1. Toma un lock (`flock`) para no correr dos veces a la vez.
2. `git fetch` de `release` en un clon espejo propio del script. Si el commit es el mismo que `current`, termina.
3. **Solo avanza si es fast-forward** respecto de la versión activa (`git merge-base --is-ancestor`). Si alguien reescribió `release`, no despliega y alerta.
4. Opcional, recomendado: `git verify-commit` contra la clave del dueño. Sin firma válida, no despliega.
5. Como `foxbuild`, en un directorio temporal: export del commit, `npm ci`, `npm test`. Si falla, borra el temporal, alerta y termina: no se tocó nada.
6. Root mueve la versión a `releases/<commit>/`, apunta `previous` a la versión actual y cambia `current` a la nueva **de forma atómica** (`ln -sfn` a un symlink temporal y `mv -T`).
7. `systemctl restart fox`. Las sesiones de fx no se cortan porque tmux vive en su propio servicio (paso 3). El browser toma la versión nueva al recargar, porque fox sirve todo con `no-store`.
8. **Chequeo de salud**, hasta 30 segundos: `systemctl is-active fox` y `curl -fsS -H 'Host: fox.<dominio>' http://127.0.0.1:4848/`, que tiene que devolver 200 con `<title>fox</title>` (página de login) o `<title>Set up fox</title>` (página de alta, antes de registrar el passkey). Con `FOX_PUBLIC_ORIGIN`, sin ese Host fox responde 403.
9. **Si el chequeo falla: rollback.** `current` vuelve a apuntar a `previous`, `systemctl restart fox`, se repite el chequeo y se alerta. Ese commit queda marcado como malo y no se reintenta hasta que `release` avance a otro.
10. Conserva las últimas 3 versiones en `releases/` y borra las más viejas.

**Límites, a dejar claros:** el rollback automático detecta lo que miden los tests y el chequeo de salud (que fox arranque y sirva la página). Un bug de la UI con fox arrancando bien no lo detecta: para eso está `sudo fox-update --rollback`, que vuelve a `previous` a mano.

**Ciclo con fx:** si fox se desarrolla con fx desde este mismo servidor, fx trabaja sobre un clon en el HOME de `fox`, hace push a `main`, y el dueño revisa y avanza `release`. El agente nunca toca `/opt/fox` ni puede avanzar `release` solo: el token de GitHub de `fox` no debe tener permiso de push a `release` (proteger la rama).

### 11. GitHub: un token por dueño
**Decidido y hecho en el VPS.** Un token fine-grained por dueño (usuario u org), cada uno con solo los repos elegidos y **Contents** + **Pull requests** en Read and write. Un token fine-grained no puede tener dos dueños.
- `jamarks`: cargado con `gh auth login` (pegar token). Es el que se usa por defecto.
- Otras orgs (hoy `hiOrchestra`): `~/.local/bin/fox-git-token <org>` pide el token con entrada oculta y lo guarda en `~/.config/fox-git/tokens/<org>` (`0600`, en minúsculas).
- `~/.local/bin/fox-git-credential` es el credential helper de git (`credential.https://github.com.useHttpPath=true`): elige el token según el dueño que viene en la ruta del repo, sin importar mayúsculas, y si no hay token para ese dueño usa `gh auth git-credential`.
- `~/.local/bin/gh` envuelve a `/usr/bin/gh`: toma el dueño de `-R`/`--repo` o del remote `origin` y exporta `GH_TOKEN` con el token que corresponde.
- Identidad de los commits: `Javier Wasserman <45493+jamarks@users.noreply.github.com>`.
- **Decidido por el dueño:** fox se desarrolla desde fox, así que el token incluye `jamarks/fox` con escritura, y lo que llegue a `release` se despliega solo. GitHub no distingue al dueño de su token, así que no hay regla que deje avanzar `release` al dueño y no al agente. Lo que sí hay: un ruleset que bloquea force push y borrado de `main` y `release`, más los tests y el rollback automático del paso 10. Si en algún momento hay más colaboradores, revisar con commits firmados verificados por `fox-update`.
- Los tokens vencen (30 a 90 días). Se renuevan editando o regenerando el token en GitHub y volviendo a cargarlo con el mismo comando.

### 12. Memoria: sesiones que duermen y herramientas sin npx
Medido en el CX23 (4 GB): fx ocupa unos 15 MB por sesión; sus herramientas Browser (Playwright MCP) y DevTools (chrome-devtools-mcp) ocupan el resto, unos 500 MB por sesión lanzadas con `npx`, aunque la sesión solo espere.
- **Sesiones que duermen:** `FOX_IDLE_SLEEP_MIN=30` en `/etc/fox/fox.env`. fox cierra la sesión de tmux de una terminal que espera input, que nadie tiene abierta y lleva 30 minutos sin actividad. La conversación queda en disco, y al abrirla fox la retoma con `fx session resume` (unos segundos). Nunca duerme una sesión trabajando, una que pide input ni una abierta en pantalla. Lo que fx haya dejado corriendo en primer plano en esa terminal se detiene; los dev servers en segundo plano siguen.
- **Herramientas sin npx:** instaladas en `~/.local/lib/fox-tools` (usuario `fox`), y la config de MCP de fx las lanza con `/usr/bin/node <ruta del cli>`. Eso elimina los dos procesos `npm exec` (unos 80 MB cada uno). Una sesión nueva pasó de unos 500 MB a 322 MB. Ya no se actualizan solas como con `npx …@latest`: `cd ~/.local/lib/fox-tools && npm update` cada tanto. Copia de la config anterior: `<fx mcp path>.bak-npx`.

### 13. Recuperar un passkey perdido
`bin/fox-enroll.mjs` se niega a emitir un código si ya existe `~/.config/fox/passkey.json`, así que no alcanza con volver a correrlo. Procedimiento manual por SSH desde `admin`:
1. `sudo systemctl stop fox`.
2. Respaldar `/home/fox/.config/fox/passkey.json` en un lugar protegido y sacarlo de la ruta activa.
3. `sudo systemctl start fox`.
4. `cd /opt/fox/current && sudo -u fox -H env FOX_PUBLIC_ORIGIN=https://fox.<dominio> node bin/fox-enroll.mjs`: código nuevo, válido 10 minutos.
5. Registrar el passkey nuevo desde `https://fox.<dominio>`, pasando por Access.
6. Verificar que las sesiones de fx sigan en disco y que la credencial vieja ya no deje entrar.

No automatizar el borrado de credenciales. Restaurar un backup que todavía contiene `passkey.json` devuelve la credencial vieja; no es una forma de recuperar el acceso.

## Pendiente de verificar

- Que fx funcione en Linux (paso 2).
- Que cloudflared preserve Host y Origin (paso 4).
- Que el WebSocket de la terminal funcione detrás de Access y cómo se comporta cuando vence la sesión (paso 5).
- Que tmux como servicio de usuario aparte funcione con fox y sobreviva a un restart de fox (paso 3).
- Que el script de actualización y el rollback funcionen de punta a punta, incluido el primer despliegue y un reinicio del VPS a mitad de una actualización (paso 10).

## Seguridad: no negociable

- fox es una shell remota sobre el servidor. Nunca `FOX_AUTH_DISABLED=1`, nunca escuchar en `0.0.0.0`, nunca correr como root y nunca darle sudo al usuario `fox`.
- fx ejecuta comandos que escribe un modelo, y un repo clonado puede traer instrucciones maliciosas (prompt injection). Todo lo que hay en el HOME de `fox` es alcanzable por un agente: credenciales mínimas y con límite (Gateway con tope de gasto, GitHub fine-grained por repo), y para repos de terceros usar fx en modo `ask`.
- No publicar el hostname ni compartir la URL hasta que pase toda la verificación del paso 7. La URL no es un secreto: la seguridad la dan Access y el passkey.
- No dejar secretos en el repo, en el chat, en la unidad systemd ni en el cloud-init. El Gateway key vive en la config de fx.
- Este fox es de una sola persona: no darle a nadie más acceso a este fox, a este Access ni al usuario `fox`.
