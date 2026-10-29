# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="web/public/assets/baton-logo.svg"><img src="web/public/assets/baton-logo-dark.svg" width="36" height="36" alt=""></picture></sub>Baton

[English](README.md) | [中文](README.zh-CN.md) | **Español**

Continúa en tu teléfono las tareas de [Claude Code](https://github.com/anthropics/claude-code) y [Codex](https://openai.com/codex) justo donde las dejaste en tu ordenador.

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton sincroniza y muestra en tiempo real las sesiones de Claude Code y Codex entre tus dispositivos, sin cambiar tu forma de trabajar. Los datos de tus sesiones permanecen en tu propia cuenta de AWS.

### Herramientas de desarrollo

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/project-files.avif" width="48%"><img src="docs/assets/showcase/project-files.avif" alt="Archivos del proyecto" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/git.avif" width="48%"><img src="docs/assets/showcase/git.avif" alt="Cambios de Git" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/terminal.avif" width="48%"><img src="docs/assets/showcase/terminal.avif" alt="Terminal móvil" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/remote-preview.avif" width="48%"><img src="docs/assets/showcase/remote-preview.avif" alt="Vista previa remota" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile-second.svg"><img src="docs/assets/showcase/tools-desktop.svg" alt="" width="100%"></picture>
</p>

### Visualización de contenido

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/permissions.avif" width="48%"><img src="docs/assets/showcase/permissions.avif" alt="Aprobación de permisos" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/mermaid.avif" width="48%"><img src="docs/assets/showcase/mermaid.avif" alt="Diagramas Mermaid" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/inline-html.avif" width="48%"><img src="docs/assets/showcase/inline-html.avif" alt="Vista previa de HTML integrado" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/file-preview.avif" width="48%"><img src="docs/assets/showcase/file-preview.avif" alt="Vista previa de archivos" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile-second.svg"><img src="docs/assets/showcase/rendering-desktop.svg" alt="" width="100%"></picture>
</p>

---

## Inicio rápido

### 1. Desplegar el servidor

Requiere [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) con permisos para crear pilas de CloudFormation.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/baton/main/server/install.sh | bash
```

Tarda unos 6–8 minutos. Al finalizar, muestra una **Start URL** y un código QR. Admite las opciones `--region`, `--stack` y `--profile` (añádelas después de `bash -s --`).

### 2. Instalar el Bridge

Requiere [Node.js](https://nodejs.org/) 20.9 o posterior.

1. Abre la **Start URL** en tu navegador (también sirve como visor web).
2. Copia el comando de una línea **Install bridge** de la página Setup.
3. Ejecútalo en el ordenador donde se esté ejecutando Claude Code o Codex.

En Windows, ejecuta el comando de instalación en PowerShell con la opción **Ejecutar como administrador**.

### 3. Descargar la aplicación

| iOS | Android | HarmonyOS | macOS | Windows |
|:---:|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.png" width="120"> | <img src="docs/assets/baton_android.png" width="120"> | <img src="docs/assets/harmonyos.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| [TestFlight](https://testflight.apple.com/join/UekStGCA) | [Baton.apk](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.apk) | [Compilar e instalar](harmony/README.md) | [Baton.dmg](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.dmg) | [Baton.exe](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.exe) |

Después de descargar la aplicación, escanea el código QR o introduce la Start URL para comenzar.

---

## Funcionalidades

### Funciones principales

- **Claude Code y Codex** — ambos entornos en un único catálogo de Dispositivo → Proyecto → Sesión.
- **Transmisión en tiempo real** — las respuestas, el razonamiento y las llamadas a herramientas aparecen a medida que se generan.
- **Seguimiento de sesiones existentes** — sigue usando Claude Code y Codex en tu ordenador como siempre; un Bridge local ligero refleja el progreso en directo y los estados de ejecución, espera de entrada y finalización.
- **Interacción con sesiones existentes** — envía mensajes de seguimiento, incluso durante la ejecución, interrumpe tareas en curso y continúa el trabajo desde cualquier dispositivo conectado.
- **Creación de proyectos y sesiones** — crea un proyecto, inicia sesiones de Claude Code, Codex o agentes de Claude en segundo plano de forma remota y sigue supervisándolas tras desconectarte.
- **Permisos y preguntas** — aprueba o rechaza llamadas a herramientas, responde preguntas y revisa planes, incluidas las aprobaciones de comandos, archivos y MCP de Codex.
- **Comandos con barra y Skills** — autocompletado con `/` para los comandos integrados y personalizados de cada entorno, las Skills de Codex y los prompts guardados.
- **Codex Goals** — establece, pausa, reanuda o elimina objetivos de una conversación con `/goal` y sigue sus turnos de continuación autónoma en tiempo real.
- **Subagentes** — subagentes anidados de Claude Code y Codex agrupados bajo su sesión principal, con estado en directo y una lista jerárquica de hilos.
- **Infraestructura propia** — despliega con un solo comando en tu cuenta de AWS; los datos de tus sesiones permanecen en ella.

### Herramientas de desarrollo

- **Archivos del proyecto** — explora el código fuente con resaltado de líneas y descarga o comparte archivos mediante las funciones nativas del sistema.
- **Git** — revisa cambios, añade o retira archivos del área de preparación, descarta cambios, crea commits, envía cambios o publica una rama y explora el gráfico de ramas con diferencias históricas.
- **Terminales** — hasta cinco sesiones de shell por proyecto, compartidas en directo entre dispositivos y restauradas al volver, con una barra de teclas móvil, un control de dirección que repite las pulsaciones al mantenerlo presionado y acelera cuanto más lo arrastras, y desplazamiento suave con inercia (Bridge en macOS o Linux).
- **Vista previa de localhost** — abre `http://localhost:3000` (o cualquier puerto local) del ordenador donde se ejecuta el Bridge dentro de la aplicación nativa, tocando un enlace de la sesión o introduciendo el puerto, sin SSH, reenvío de puertos ni exposición pública.

### Rápido, estable y ligero

- **Experiencia de aplicación nativa** — la pantalla de inicio nativa da paso sin interrupciones a las pantallas de carga de cada etapa, sin destellos blancos; al deslizar desde el borde para volver, se revela la página anterior.
- **Carga instantánea** — las listas, el historial y los datos del proyecto se abren desde la caché local y se actualizan en segundo plano.
- **Entrega estable** — la transmisión ordenada, la reconexión automática y la cola de envíos mantienen la continuidad de las sesiones con redes móviles inestables y después de pasar la aplicación a segundo plano.
- **Aplicaciones ligeras** — paquetes nativos pequeños basados en Tauri, además de una aplicación contenedora con ArkWeb para HarmonyOS NEXT.
- **Bridge sin mantenimiento** — funciona de forma permanente en macOS, Linux y Windows, conecta varios ordenadores a una cuenta y se actualiza automáticamente.

### Visualización de contenido

- **Cronología de ejecución** — llamadas a herramientas y resultados plegables, con la salida completa disponible bajo demanda.
- **Diferencias, Mermaid y LaTeX** — se muestran integrados mientras se recibe la respuesta.
- **HTML integrado en las conversaciones** — vistas previas interactivas que se pueden ampliar a pantalla completa sin perder su estado.
- **Vista previa de archivos** — archivos Markdown, HTML, PDF, Office, imágenes y vídeos de proyectos o mensajes; las páginas HTML cargan sus CSS, scripts e imágenes con rutas relativas y se muestran completas sin un servidor local; las imágenes de los mensajes se muestran integradas y se pueden abrir a pantalla completa y ampliar con dos dedos.

### Más funciones

- **Entrada de archivos, imágenes y voz** — adjunta archivos, envía imágenes comprimidas y dicta mensajes en iOS.
- **Borradores de sesión** — conserva el texto y los archivos adjuntos ya subidos al cambiar de sesión o volver a abrir la aplicación en el mismo dispositivo.
- **Gestión de sesiones** — cambia el nombre de las sesiones mediante su entorno nativo y mantén pulsado para seleccionar y eliminar varias sesiones o proyectos, con la opción de eliminar también sus archivos locales.
- **Gestión de dispositivos** — elimina dispositivos de Baton y detén sus Bridges conectados, conservando los archivos locales de las sesiones.
- **Rotación de la clave API** — cambia la clave API con `--rotate-key` y conserva los datos existentes.
- **Pestañas en macOS** — trabaja en varias sesiones mediante pestañas independientes.
- **Estadísticas de uso de Claude** — consulta el estado, la configuración, los límites de uso, el historial de tokens y los gráficos de uso de modelos.

---

## Arquitectura

```text
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│ (local hosts)  │               │  (AWS APIs)    │               │  (phone/desktop) │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │ DynamoDB + S3  │
                                 │ (data + media) │
                                 └────────────────┘
```

El **Bridge** descubre las sesiones de Claude Code y Codex, normaliza sus eventos, conserva las relaciones entre agentes principales y subagentes y gestiona el control local de agentes, los archivos del proyecto, los comandos de Git y los procesos de terminal. El **Server** autentica y enruta los mensajes de control, almacena los datos de las sesiones y los hilos raíz en DynamoDB y sirve los archivos multimedia sincronizados mediante S3. La **App/Web** carga el historial en caché, se suscribe a las actualizaciones de las sesiones y los agentes raíz, agrupa los hilos anidados bajo la sesión principal y envía las acciones del usuario al entorno local correspondiente.

---

## ¿Por qué Baton?

Baton alude tanto al testigo de una carrera de relevos como a la batuta de un director de orquesta: te permite retomar el trabajo en otro dispositivo y dirigir a tus agentes a distancia.

---

## Desinstalación

Consulta la [guía de desinstalación](scripts/uninstall/README.md).

---

## Licencia

MIT
