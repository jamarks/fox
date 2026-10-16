# fox solo nube en un VPS (Hetzner)

Handoff para el agente que lo implemente. Primero las decisiones tomadas y por qué; después los pasos, lo que hay que verificar y lo que no hay que hacer.

## Decisiones tomadas

1. **Objetivo:** fox corre solo en la nube, sin nada local, y se usa desde cualquier dispositivo (teléfono, laptop, otro browser) sin Tailscale ni el pairing por QR.
2. **Dónde:** un VPS siempre prendido en Hetzner, con Ubuntu 24.04 y unos 2 vCPU / 4 GB (CX22 o similar, unos €4–5/mes). Cualquier VPS con Ubuntu sirve igual; Hetzner se eligió por precio.
3. **Descartados por ahora:**
   - **Vercel Sandbox.** Las sesiones duran como máximo 24 h en Pro (45 min en Hobby). Al apagarse se guarda solo el disco, no los procesos (tmux y fx mueren). No se apaga solo por inactividad, así que fox tendría que dormirlo y despertarlo, y las URLs públicas no tienen login. Queda como posible demo futura para llamar la atención de Vercel, no como base.
   - **El enfoque de pi sobre Cloudflare Durable Objects.** Sirve cuando el loop del agente es tuyo. fox envuelve el binario de fx, que necesita una máquina real.
   - **Exponer un puerto con Caddy.** Es válido, pero se prefiere el túnel para no abrir ningún puerto.
4. **Entrada, con dos candados y cero puertos abiertos:**
   - **Cloudflare Tunnel con nombre** (`cloudflared` como servicio en el VPS, conexión saliente). No es el Quick Tunnel que usa `tunnel.mjs`.
   - **Cloudflare Access** delante del hostname: login por mail o Google, solo para el dueño. Es el primer candado y frena a cualquiera antes de que llegue a fox.
   - **El passkey remoto de fox** (`FOX_PUBLIC_ORIGIN`, ya implementado en el commit 62a646e; ver `docs/plans/2026-10-16-remote-passkey-design.md`). Es el segundo candado.
5. **Un usuario y un VPS.** Todos los repos y todas las sesiones de fx viven en el VPS, bajo un usuario Linux `fox` (nunca root).
6. **Login de fx:** API key del Vercel AI Gateway (`fx setup`). No está verificado que el login con suscripción de ChatGPT (`fx login codex`) funcione sin navegador.
7. **El modo local sigue existiendo y no se toca.** `FOX_PUBLIC_ORIGIN` ya se niega a combinarse con `FOX_SHARE_PORT`, `FOX_MOBILE_PORT` y `FOX_AUTH_DISABLED`; el pairing y Tailscale quedan para el modo local.

## Lo que ya existe en el código

- `FOX_PUBLIC_ORIGIN=https://fox.<dominio>`: chequea exactamente Host y Origin en los requests y en los WebSocket, usa cookies `Secure; HttpOnly; SameSite=Strict` y fija el rpID de WebAuthn al dominio. Sigue escuchando solo en `127.0.0.1:4848`.
- `node bin/fox-enroll.mjs`: genera un código de un solo uso (10 min) para registrar el primer passkey. Se corre por SSH.
- Los requisitos de infraestructura están en el README (sección del modo VPS con passkey) y el plan del passkey remoto los lista.

## Lo que hace la persona, no el agente

El agente **no** crea cuentas, no compra, no ingresa contraseñas ni tarjetas y no pega API keys en el chat. Esto lo hace la persona:

1. Crear la cuenta de Hetzner y un servidor CX22 con Ubuntu 24.04 y su clave SSH pública. Pasarle al agente la IP.
2. Tener un dominio con el DNS en Cloudflare y activar Cloudflare Zero Trust (plan gratis). Decidir el hostname, por ejemplo `fox.<dominio>`.
3. Correr `cloudflared tunnel login` en el VPS cuando el agente lo pida: abre un link que hay que autorizar en el browser.
4. Crear la API key del AI Gateway y cargarla en el VPS con `fx setup`, por SSH, sin pasarla por el chat.
5. Si fx tiene que hacer push a GitHub: generar una deploy key o un token con permisos mínimos y cargarlo en el VPS.

## Pasos para el agente

### 1. Endurecer el servidor
- Crear el usuario `fox` con sudo y copiarle la clave SSH.
- `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`. Reiniciar sshd **después** de verificar que entrar como `fox` funciona.
- `ufw`: denegar todo lo entrante salvo 22/tcp. Nada más: el túnel es saliente.
- Activar `unattended-upgrades`. fail2ban es opcional.

### 2. Dependencias (como `fox`)
- Node 22 LTS (NodeSource o nvm), `tmux`, `git`, `build-essential` y `python3` (los necesita `node-pty`).
- fx: `curl -fsSL https://fx.sh/setup.sh | bash`. **Verificar que fx soporte Linux x64 o arm64**; si no, parar y avisar.
- Que la persona corra `fx setup` (paso 4 de la sección anterior). Comprobar con `fx status` y `fx doctor`.

### 3. fox como servicio
- `git clone https://github.com/jamarks/fox ~/fox && cd ~/fox && npm ci`.
- Unidad systemd `/etc/systemd/system/fox.service`:

```ini
[Unit]
Description=fox
After=network-online.target

[Service]
User=fox
WorkingDirectory=/home/fox/fox
Environment=FOX_PUBLIC_ORIGIN=https://fox.<dominio>
Environment=PORT=4848
ExecStart=/usr/bin/node server.mjs
Restart=always
# fox lanza el servidor de tmux. Sin esto, reiniciar fox mata tmux y todas las sesiones de fx.
KillMode=process

[Install]
WantedBy=multi-user.target
```

- Usar `npm start` o `node server.mjs`, nunca `fox`: el CLI intenta abrir un browser local.
- Verificar que `KillMode=process` alcance. Si tmux igual muere con `systemctl restart fox`, lanzar tmux en su propio scope (`systemd-run --user --scope`) o con un servicio aparte.

### 4. Cloudflare Tunnel
- Instalar `cloudflared` desde el repo apt oficial de Cloudflare.
- La persona corre `cloudflared tunnel login`. Después: `cloudflared tunnel create fox` y `cloudflared tunnel route dns fox fox.<dominio>`.
- `/etc/cloudflared/config.yml`: ingress `fox.<dominio>` → `http://127.0.0.1:4848` y una regla final `http_status:404`. Instalar como servicio con `cloudflared service install`.
- **Verificar que el Host que le llega a fox sea `fox.<dominio>`** y que el header Origin pase intacto. fox rechaza cualquier otro valor, y eso es lo que tiene que pasar.

### 5. Cloudflare Access
- Zero Trust → Access → Applications → Self-hosted, con el hostname `fox.<dominio>`.
- Política: Allow, que incluya solo el mail del dueño. Método: one-time PIN por mail o Google.
- Duración de sesión de 24 h. Confirmar que, al vencer, la terminal se reconecta después de volver a loguearse y no queda colgada.

### 6. Registrar el passkey
- Por SSH, como `fox`: `FOX_PUBLIC_ORIGIN=https://fox.<dominio> node bin/fox-enroll.mjs`.
- La persona abre `https://fox.<dominio>`, pasa Access, escribe el código y crea el passkey. Conviene registrarlo en un gestor que sincronice (iCloud Keychain o 1Password) para que funcione en el teléfono y en la laptop.
- No copiar el `~/.config/fox/passkey.json` de la Mac: el de localhost no sirve en el dominio, y fox se niega a arrancar si lo encuentra.

### 7. Verificación (todo tiene que pasar antes de usarlo en serio)
- `curl -I https://fox.<dominio>` sin sesión de Access → redirige al login de Cloudflare.
- Desde afuera, el puerto 4848 está cerrado (`nmap -p 4848,80,443 <ip>`). Solo el 22 abierto.
- Con Access y sin passkey: la API y el WebSocket `/pty` responden 401 o 403.
- El flujo completo en un browser real, en laptop y teléfono: Access, passkey, panel, terminal en vivo, escribir en fx.
- `sudo systemctl restart fox` → las sesiones de tmux y fx siguen vivas y se reconectan.
- Reiniciar el VPS → fox y cloudflared vuelven solos. Las sesiones de tmux mueren; comprobar que `fx session resume <id>` (o abrirla desde fox) retoma la conversación.
- El dictado funciona en el teléfono (necesita HTTPS, que ya está).

### 8. Cambios en fox para el modo nube
Ninguno bloquea; son para que la experiencia tenga sentido sin Mac. Detectar el modo con `FOX_PUBLIC_ORIGIN`, o con `process.platform !== 'darwin'` cuando sea algo específico de macOS.
- **Abrir un archivo con ↗** (`server.mjs`, cerca de la línea 431) hoy responde 501 fuera de macOS. En modo nube: ocultar el botón o reemplazarlo por una descarga.
- **Selector de carpeta nativo** (`/api/pick-folder`, cerca de la línea 532) usa osascript. En modo nube: escribir la ruta, o un explorador de carpetas simple del lado del servidor dentro de `$HOME`.
- **Nuevo proyecto desde una URL de git**: "clonar y abrir fx ahí". En la nube no hay carpetas locales que elegir.
- **Retomar al arrancar:** si fox arranca y no hay tmux (por ejemplo después de un reboot), ofrecer reabrir las sesiones que estaban abiertas con `fx session resume`.
- **README:** sección "Cloud mode" con este recorrido. El README hoy promete "Nothing leaves your machine": ajustarlo para que ese sea el modo local.
- **`setup-vps.sh`** (opcional): automatizar los pasos 1 a 4, idempotente y sin manejar secretos.

### 9. Backups
- Activar los backups de Hetzner (+20% del precio) o correr `restic` sobre `/home/fox` (repos, `~/.fx` y `~/.config/fox`) hacia un bucket.
- El passkey vive en `~/.config/fox/passkey.json`. Si se pierde, se vuelve a registrar con `fox-enroll` por SSH.

## Pendiente de verificar

- Que fx funcione en Linux (paso 2).
- Que cloudflared preserve Host y Origin (paso 4).
- Que el WebSocket de la terminal funcione detrás de Access y cómo se comporta cuando vence la sesión (paso 5).
- Que `KillMode=process` alcance para que tmux sobreviva a un restart de fox (paso 3).
- Si `fx login codex` funciona sin navegador. Si no, el plan es usar solo el Gateway.

## Seguridad: no negociable

- fox es una shell remota sobre el servidor. Nunca `FOX_AUTH_DISABLED=1`, nunca escuchar en `0.0.0.0` y nunca correr como root.
- No publicar el hostname ni compartir la URL hasta que pase toda la verificación del paso 7.
- No dejar secretos en el repo, en el chat ni en la unidad systemd. El Gateway key vive en la config de fx.
