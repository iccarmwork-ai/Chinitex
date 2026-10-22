# Chinitex

La versión portátil está en `Chinitex.html`, en la raíz de este repositorio. Guarda ese archivo en tu computadora y ábrelo con Chrome o Edge. Esta distribución no contiene conversaciones: pulsa **Importar chats** y selecciona los JSON de tu exportación. Puedes seleccionar también los archivos auxiliares; la aplicación conserva únicamente las conversaciones reconocidas.

Una biblioteca personal de conversaciones con proyectos, referencias y un tablero de tareas. Funciona en el navegador sin una cuenta adicional y puede abrirse sin conexión.

**Uso.** Abre `dist/Chinitex.html` en un navegador. Importa juntos los archivos JSON de conversaciones de una exportación de ChatGPT; puedes seleccionar también los JSON auxiliares, que se ignoran si no contienen conversaciones. Busca por título o por el texto de tus propios mensajes y guarda como favoritas las referencias que quieras recuperar. La biblioteca no incluye las respuestas del asistente, sus razonamientos ni los contenidos físicos de documentos o imágenes referenciados.

Puedes crear fichas de proyectos con fuentes y siguiente acción, y organizar tareas por estado. Una conversación antigua es un antecedente: no se convierte automáticamente en un pendiente, un plazo vigente o un documento aprobado. Los filtros de temas y modelos son orientativos.

Las tareas, fichas y favoritas se conservan en este navegador cuando permite almacenamiento local. Las conversaciones que importas durante una sesión deben guardarse en una copia para conservarlas al cerrar; el historial incluido originalmente en un HTML personalizado permanece dentro de ese archivo.

Usa **Guardar copia** para descargar una copia completa del historial cargado y de tus cambios. El archivo contiene datos personales si los has importado. Para restaurarlo, selecciónalo mediante el mismo control de importación. Conserva una copia fuera del navegador: sus datos locales pueden desaparecer al borrarlos o al cambiar de navegador o de ubicación del archivo.

Chinitex no accede automáticamente a tu cuenta de ChatGPT ni actualiza los chats nuevos. Debes importar otra exportación para añadirlos. No necesita enviar tus conversaciones a un servicio externo para buscar o administrar las fichas.

**Desarrollo.** Requiere Node.js 22 o superior. No tiene dependencias de npm y no hace falta ejecutar `npm install`.

```sh
npm test
npm run build
```

El build sin opciones genera `dist/Chinitex.html` y `dist/index.html`, sin conversaciones personales. Los dos son archivos autónomos con estilos y código incluidos. La carpeta `dist` está excluida de Git.

Para servir la compilación durante el desarrollo, Python 3 permite ejecutar:

```sh
npm start
```

El servidor usa el puerto 4173 y escucha solo en el equipo local. La aplicación final también funciona abriendo el HTML directamente.

**Compilación con un historial.** El build admite un manifiesto local con esta estructura:

```json
[
  {"name": "conversations-000.json", "path": "/ruta/privada/conversations-000.json"},
  {"name": "conversations-001.json", "path": "/ruta/privada/conversations-001.json"}
]
```

Las rutas relativas se resuelven desde el directorio del manifiesto. Solo se leen las entradas llamadas `conversations-NNN.json`; se combinan por identificador, conservando la versión más reciente.

```sh
node scripts/build.mjs --manifest /ruta/privada/archivos.json --out /ruta/privada/Chinitex.html
```

Con `--out` se escribe únicamente el archivo indicado. Ese HTML incluye el historial y puede abrirse sin los JSON originales. Guarda los manifiestos y las exportaciones fuera del código fuente o en `data/`, que está excluida de Git. No añadas datos personales al repositorio. El código fuente y las pruebas utilizan estructuras genéricas; la compilación privada se prepara por separado.

**Organización del código.** `src/core.mjs` contiene importación, búsqueda, filtros y validación de copias; `src/app.mjs` controla la interfaz; `src/index.html` y `src/styles.css` definen la presentación. `scripts/build.mjs` genera el HTML autónomo sin descargar paquetes ni usar servicios externos.
