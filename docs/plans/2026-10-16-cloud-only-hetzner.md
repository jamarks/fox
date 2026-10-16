# fox solo nube en un VPS (Hetzner)

Handoff para el agente que lo implemente. Primero las decisiones tomadas y por qué; después los pasos, lo que hay que verificar y lo que no hay que hacer.

## Decisiones tomadas

1. **Objetivo:** fox corre solo en la nube, sin nada local, y se usa desde cualquier dispositivo (teléfono, laptop, otro browser) sin Tailscale ni el pairing por QR.
2. **Una persona por VPS.** Si un colega quiere lo mismo, repite este plan en **su propio VPS**, con su dominio o subdominio, su Access, su passkey y sus credenciales.
   - **Descartado un VPS compartido** con un fox por integrante. Exige un usuario Linux, un servicio, un puerto, un ingress y una app de Access por persona, más altas y bajas manuales. Solo da aislamiento débil: mismo kernel, mismo loopback, `/proc` y `/tmp` compartidos y recursos compartidos. Y no se comparte nada útil, porque repos y sesiones tienen que quedar separados igual. Un VPS más cuesta unos €5–15 y es más simple y más seguro. El borrador descartado no está en el repo.
3. **Dónde:** Hetzner, Ubuntu 24.04, **región Ashburn (EE. UU.)** si se usa desde Argentina, para que la terminal no se sienta lenta (cada tecla va y vuelve). **8 GB de RAM** (CPX31, CX32 o similar): dos agentes, más Chromium de Playwright, más un dev server no entran en 4 GB. Medir con carga real y ajustar. Cualquier VPS con Ubuntu sirve igual.
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
7. **Login de fx:** API key del Vercel AI Gateway (`fx setup`) **con límite de gasto**. No está verificado que el login con suscripción de ChatGPT (`fx login codex`) funcione sin navegador.
8. **El modo local sigue existiendo y no se toca.** `FOX_PUBLIC_ORIGIN` ya se niega a combinarse con `FOX_SHARE_PORT`, `FOX_MOBILE_PORT` y `FOX_AUTH_DISABLED`; el pairing y Tailscale quedan para el modo local.

## Lo que ya existe en el código

- `FOX_PUBLIC_ORIGIN=https://fox.<dominio>`: chequea exactamente Host y Origin en los requests y en los WebSocket, usa cookies `Secure; HttpOnly; SameSite=Strict` y fija el rpID de WebAuthn al dominio. Sigue escuchando solo en `127.0.0.1:4848`.
- `node bin/fox-enroll.mjs`: genera un código de un solo uso (10 min, 43 caracteres aleatorios) para registrar el primer passkey. Se corre por SSH.
- Las páginas de `/view/` corren con CSP `sandbox` (origen opaco): no pueden llamar a la API de fox ni abrir terminales. Su token funciona como llave y vence a las 2 h.
- Los requisitos de infraestructura están en el README (sección del modo VPS con passkey) y el plan del passkey remoto los lista.

## Lo que hace la persona, no el agente

El agente **no** crea cuentas, no compra, no ingresa contraseñas ni tarjetas y no pega API keys en el chat. Esto lo hace la persona:

1. Crear la cuenta de Hetzner y el servidor (Ubuntu 24.04, 8 GB, región Ashburn) con su clave SSH pública. Pasarle al agente la IP. **No poner secretos en el cloud-init / user-data**: el servicio de metadata los expone a cualquier proceso del VPS.
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
- Código de fox en **`/opt/fox`, propiedad de root y de solo lectura para `fox`**: `git clone https://github.com/jamarks/fox /opt/fox && cd /opt/fox && npm ci`. Así un agente no puede modificar el fox que lo controla.
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
WorkingDirectory=/opt/fox
Environment=FOX_PUBLIC_ORIGIN=https://fox.<dominio>
Environment=PORT=4848
Environment=TMUX_TMPDIR=/home/fox/.tmux
ExecStart=/usr/bin/node /opt/fox/server.mjs
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
- Desde `admin`: `cd /opt/fox && sudo -u fox -H env FOX_PUBLIC_ORIGIN=https://fox.<dominio> node bin/fox-enroll.mjs`.
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
- Dos agentes trabajando a la vez, uno con el navegador de Playwright: medir RAM, CPU y swap, y ajustar el tamaño del VPS y los límites del paso 3.

### 8. Cambios en fox para el modo nube
Detectar el modo con `FOX_PUBLIC_ORIGIN`, o con `process.platform !== 'darwin'` cuando sea algo específico de macOS. En orden de prioridad:
1. **Ver los dev servers.** Es el hueco de producto más grande. Si fx levanta `npm run dev` en el 3000, hoy no hay forma de abrirlo desde el browser: `/view/` solo sirve archivos estáticos. Hace falta un proxy de previews dentro de fox, detrás del passkey (por ejemplo `/preview/<puerto>/` limitado a un rango de puertos locales), con soporte de WebSocket para el hot reload. Diseñarlo antes de implementarlo: aislar el origen para que el dev server no pueda llamar a la API de fox con la cookie del dueño.
2. **Nuevo proyecto desde una URL de git**: "clonar y abrir fx ahí". En la nube no hay carpetas locales que elegir.
3. **Selector de carpeta nativo** (`/api/pick-folder`, cerca de la línea 532) usa osascript. En modo nube: escribir la ruta, o un explorador de carpetas simple del lado del servidor dentro de `$HOME`.
4. **Abrir un archivo con ↗** (`server.mjs`, cerca de la línea 431) hoy responde 501 fuera de macOS. En modo nube: ocultar el botón o reemplazarlo por una descarga.
5. **Retomar al arrancar:** si fox arranca y no hay sesiones de tmux (por ejemplo después de un reboot), ofrecer reabrir las que estaban abiertas con `fx session resume`.
6. **Validar el JWT de Access** (`Cf-Access-Jwt-Assertion`, contra los certificados del team de Cloudflare). Opcional con una sola persona, pero suma defensa: fox rechaza cualquier request que no haya pasado por Access, incluso desde el propio VPS.
7. **README:** sección "Cloud mode" con este recorrido. El README hoy promete "Nothing leaves your machine": ajustarlo para que ese sea el modo local.
8. **`setup-vps.sh`** (opcional): automatizar los pasos 1 a 4, idempotente y sin manejar secretos. Es lo que hace fácil que un colega repita el plan en su propio VPS.

### 9. Operación
- **Backups:** activar los backups de Hetzner (+20% del precio) o correr `restic` sobre `/home/fox` (repos, `~/.fx` y `~/.config/fox`) hacia un bucket cifrado. El passkey vive en `~/.config/fox/passkey.json`.
- **Monitoreo mínimo:** una alerta si el disco pasa el 80% y si fox, tmux o cloudflared se caen. Por ejemplo, un healthcheck externo (Healthchecks.io, gratis) alimentado por un timer de systemd.
- **Actualizar fox:** como `admin`, `cd /opt/fox && git pull && npm ci` (node-pty se recompila), y después `systemctl restart fox`. Las sesiones de fx no se cortan porque tmux vive aparte.

### 10. Recuperar un passkey perdido
`bin/fox-enroll.mjs` se niega a emitir un código si ya existe `~/.config/fox/passkey.json`, así que no alcanza con volver a correrlo. Procedimiento manual por SSH desde `admin`:
1. `sudo systemctl stop fox`.
2. Respaldar `/home/fox/.config/fox/passkey.json` en un lugar protegido y sacarlo de la ruta activa.
3. `sudo systemctl start fox`.
4. `cd /opt/fox && sudo -u fox -H env FOX_PUBLIC_ORIGIN=https://fox.<dominio> node bin/fox-enroll.mjs`: código nuevo, válido 10 minutos.
5. Registrar el passkey nuevo desde `https://fox.<dominio>`, pasando por Access.
6. Verificar que las sesiones de fx sigan en disco y que la credencial vieja ya no deje entrar.

No automatizar el borrado de credenciales. Restaurar un backup que todavía contiene `passkey.json` devuelve la credencial vieja; no es una forma de recuperar el acceso.

## Pendiente de verificar

- Que fx funcione en Linux (paso 2).
- Que cloudflared preserve Host y Origin (paso 4).
- Que el WebSocket de la terminal funcione detrás de Access y cómo se comporta cuando vence la sesión (paso 5).
- Que tmux como servicio de usuario aparte funcione con fox y sobreviva a un restart de fox (paso 3).
- Si `fx login codex` funciona sin navegador. Si no, el plan es usar solo el Gateway.

## Seguridad: no negociable

- fox es una shell remota sobre el servidor. Nunca `FOX_AUTH_DISABLED=1`, nunca escuchar en `0.0.0.0`, nunca correr como root y nunca darle sudo al usuario `fox`.
- fx ejecuta comandos que escribe un modelo, y un repo clonado puede traer instrucciones maliciosas (prompt injection). Todo lo que hay en el HOME de `fox` es alcanzable por un agente: credenciales mínimas y con límite (Gateway con tope de gasto, GitHub fine-grained por repo), y para repos de terceros usar fx en modo `ask`.
- No publicar el hostname ni compartir la URL hasta que pase toda la verificación del paso 7. La URL no es un secreto: la seguridad la dan Access y el passkey.
- No dejar secretos en el repo, en el chat, en la unidad systemd ni en el cloud-init. El Gateway key vive en la config de fx.
- Para un colega: su propio VPS con este plan. Nunca darle acceso a este fox, a este Access ni a este usuario.
