# Bandeja de respuestas nuevas

Mostrar en la parte superior de la barra lateral un contador desplegable de sesiones principales con una respuesta de fx no leída. Cada fila contiene título, proyecto, hora y fragmento de la última respuesta. El clic abre esa respuesta en el transcript (incluso si la terminal está abierta) y solo entonces la marca leída. Abrir la sesión manualmente también cuenta como lectura; el sondeo no.

El servidor añade a cada sesión `latestReply` calculado desde `events.jsonl`: última respuesta no vacía del asistente perteneciente a un `turn_completed`, identificada por número de turno completado e índice del mensaje. Sin turno completado no se muestra una respuesta parcial. La lista inicial se considera leída para evitar inundar instalaciones existentes. En adelante los contadores vistos se guardan en `localStorage` por navegador; un turno nuevo vuelve a aparecer aunque la sesión ya estuviese seleccionada. No se usan heurísticas de `waiting`, modelos ni datos de herramientas. Las sesiones archivadas y los subagentes no llenan la bandeja.

Probar extracción, turnos parciales, primer arranque, marcación de lectura y la persistencia lógica. Verificar sintaxis, tests y UI básica. No crear commit salvo pedido explícito.
