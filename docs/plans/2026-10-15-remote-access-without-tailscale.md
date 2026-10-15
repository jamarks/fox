# Plan: acceso remoto al mismo fox sin cuenta de Tailscale

## Objetivo y límites

Desde fuera de casa, abrir **el mismo panel fox** de la Mac (sesiones y terminales tmux en vivo) desde un teléfono u otra computadora. La Mac debe estar encendida y fox corriendo. No copiar `~/.fx`, migrar procesos, crear otra interfaz móvil ni publicar fox directamente en internet. El trabajo responsive del panel existente queda fuera de este plan.

## Decisión previa: conectividad

1. Comprobar si el router admite WireGuard y si la conexión tiene una dirección pública alcanzable. Comparar la dirección WAN del router con la pública observada; revisar IPv4, IPv6, CGNAT, posibilidad de abrir un puerto UDP y cambios de dirección. No modificar el router durante este diagnóstico.
2. Si hay conectividad entrante: recomendar **WireGuard propio**, preferiblemente en el router si lo soporta; si no, evaluar WireGuard en la Mac más redirección del puerto UDP en el router. Claves locales, sin cuenta de proveedor de VPN. Si cambia la IP, usar un nombre DNS dinámico opcional (puede requerir una cuenta) o actualizar la dirección manualmente.
3. Si hay CGNAT IPv4, evaluar IPv6 pública con reglas de firewall y clientes compatibles. Si no hay dirección alcanzable, la conexión directa no es viable: pedir una IP pública al ISP, usar un servidor/relay propio con IP pública (implica contratar o disponer de infraestructura), o reconsiderar un servicio administrado. No prometer que instalar paquetes por sí solo resuelve NAT/CGNAT.

## Diseño de la opción WireGuard directa

- La VPN autentica cada dispositivo mediante claves; configurar pares individuales para poder revocar uno sin reemplazar todos. No poner claves privadas ni QR de configuración en el repo, logs o capturas.
- Mantener fox escuchando en `127.0.0.1` y publicar **solo dentro de la VPN** un reverse proxy hacia ese puerto, o usar un túnel local equivalente. No redirigir ni exponer el puerto HTTP 4848 hacia internet. El único puerto público, si se requiere, es el UDP de WireGuard.
- Tratar la pertenencia a la VPN como control de red, no como login de fox: evaluar una autenticación adicional para el panel y el WebSocket antes de habilitar acceso completo, sobre todo si hay otros usuarios en la VPN. Mantener las comprobaciones de origen para HTTP y WebSocket y verificar que el proxy preserva el `Host` esperado y permite upgrade de WebSocket. Configurar firewall para que el proxy sea accesible solo desde la interfaz/subred VPN.
- Documentar inicio/reinicio del servicio en la Mac, comportamiento al suspenderla y rotación/revocación de claves. Evitar automatizar cambios de router o firewall desde `fox`.

## Implementación futura por fases

1. **Diagnóstico guiado:** registrar capacidades del router/ISP (sin guardar credenciales) y elegir router WireGuard, Mac WireGuard, IPv6 o fallback. Preguntar antes de abrir puertos, instalar herramientas o contratar servicios.
2. **Endurecer fox:** decidir si el panel requiere autenticación propia además de la VPN; proteger tanto HTTP como WebSocket, revisar rutas que escriben archivos, ejecutan herramientas o envían entrada a tmux; agregar tests de acceso denegado y origen cruzado.
3. **VPN y proxy:** preparar configuraciones mínimas para Mac/router y un dispositivo cliente, instrucciones de proxy **solo VPN**, activación manual y rollback. No usar Funnel ni publicar el panel completo en WAN.
4. **Prueba real:** con el teléfono en datos móviles (Wi-Fi apagado), abrir la misma sesión, leer respuestas, conectar terminal WebSocket y enviar un mensaje inocuo; confirmar que el acceso sin VPN falla. Probar revocación de un dispositivo y reinicio de fox/Mac. No afirmar funcionamiento externo solo por tests locales.

## Verificación y salida

Tests de HTTP/WebSocket detrás del proxy, firewall/escucha en interfaces correctas, control de acceso negativo, reinicio y prueba física desde otra red. Si no hay IP alcanzable o la autenticación no está resuelta, detenerse: no abrir fox a internet. Rollback: cerrar puerto UDP del router, desactivar VPN/proxy y mantener fox en loopback; las sesiones de fx en tmux no se borran.

## Estado al redactar

No se configuró VPN, router ni proxy; no se verificó la topología del ISP. En este checkout fox escucha en `127.0.0.1:4848`; las herramientas `wg` y `tailscale` no aparecen en el PATH. Hay cambios simultáneos de otra sesión en la interfaz y un prototipo de vista móvil separado sin commit: no modificarlos como parte de este plan.
