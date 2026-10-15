# Acceso móvil de solo lectura

Diseño aprobado: mantener el panel local completo en `127.0.0.1:4848` y habilitar opcionalmente un segundo listener local con `FOX_MOBILE_PORT`. Tailscale Serve debe apuntar **solo** a ese segundo puerto: no publicar el panel completo. Este listener permite únicamente su propia interfaz móvil, sesiones resumidas, búsqueda de mensajes y mensajes de una sesión. No incluye archivos, herramientas, comandos, terminal ni WebSocket. El cliente presenta lista, última respuesta y lectura de mensajes, más búsqueda; no modifica el estado de las sesiones. No configura Tailscale ni cambia la conexión actual de fox.

Verificación: probar rutas permitidas y rechazadas (POST y WebSocket), sintaxis y tests existentes. La prueba real entre dispositivos requiere Tailscale instalado en ambos y la Mac encendida.
