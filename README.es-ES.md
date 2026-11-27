# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="web/public/assets/baton-logo.svg"><img src="web/public/assets/baton-logo-dark.svg" width="36" height="36" alt=""></picture></sub>Baton

[English](README.md) | [中文](README.zh-CN.md) | **Español**

Continúa en tu teléfono las tareas de [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://openai.com/codex) y otros agentes de programación justo donde las dejaste en tu ordenador.

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton transmite y muestra en tiempo real, sin interferir en tu forma de trabajar, las Sessions de Claude Code, Codex, Pi, Hermes, OpenCode, Kiro y DeepSeek Harness en todos tus dispositivos. Todo va cifrado de extremo a extremo y tus conversaciones permanecen en tu propio ordenador.


## Inicio rápido

### Opción A: Relay alojado por Baton

#### 1. Instala el Bridge en tu ordenador

```bash
curl -fsSL https://agentbaton.app/install | bash
```

<details>
<summary>Windows</summary>

En PowerShell, con la opción **Ejecutar como administrador**:

```powershell
irm https://agentbaton.app/install.ps1 | iex
```

</details>

#### 2. Descarga la App y conéctate

| iOS | Android | HarmonyOS | macOS | Windows | Linux |
|:---:|:---:|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.avif" width="88" alt="iOS"> | <img src="docs/assets/baton_android.avif" width="88" alt="Android"> | <img src="docs/assets/harmonyos.avif" width="88" alt="HarmonyOS"> | <img src="docs/assets/macOS.avif" width="88" alt="macOS"> | <img src="docs/assets/windows.avif" width="88" alt="Windows"> | <img src="docs/assets/linux.avif" width="88" alt="Linux"> |
| [TestFlight](https://testflight.apple.com/join/2HqQHD22) | [Baton.apk](https://dl.agentbaton.app/Baton.apk) | [Compilar e instalar](harmony/README.md) | [Baton.dmg](https://dl.agentbaton.app/Baton.dmg) | [Baton.exe](https://dl.agentbaton.app/Baton.exe) | [Baton.deb](https://dl.agentbaton.app/Baton.deb) |

Escanea el código QR que muestra el Bridge o pega su **Start URL**.

### Opción B: Relay alojado en tu cuenta de AWS

<details>
<summary>Pasos de despliegue</summary>

**1. Desplegar el servidor**

Requiere [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) con permisos para crear pilas de CloudFormation, además de `git`, `zip` y `openssl`.

```bash
curl -fsSL https://raw.githubusercontent.com/agentbaton/baton/main/server/install.sh | bash
```

Tarda unos 6–8 minutos. Al finalizar, muestra una **Start URL** (y un código QR si Node.js está instalado). Admite las opciones `--region`, `--stack` y `--profile` (añádelas después de `bash -s --`).

**2. Instalar el Bridge**

1. Abre la **Start URL** en tu navegador (también sirve como visor web).
2. Copia el comando de una línea **Install bridge** de la página Setup.
3. Ejecuta el comando en el ordenador donde usas tu agente de programación.

En Windows, ejecuta el comando de instalación en PowerShell con la opción **Ejecutar como administrador**.

Después, descarga la App indicada arriba y escanea el código QR o introduce la Start URL.

</details>

---

## Funcionalidades

### Funciones principales

- **Agentes populares** — Claude Code, Codex, Pi, Hermes, OpenCode, Kiro y DeepSeek Harness, en una sola lista.
- **Relevo en ambos sentidos** — las Sessions de tu ordenador llegan en directo al móvil, con su estado (en curso, necesita respuesta, terminada); crea proyectos y Sessions en el móvil y continúa en el ordenador.
- **Aprobaciones y preguntas** — aprueba o rechaza llamadas a herramientas, responde preguntas y revisa planes desde el móvil.
- **Notificaciones** — recibe un aviso cuando una Session termina o te necesita; tócalo para abrirla.
- **Chat cifrado de extremo a extremo** — tu ordenador guarda el historial de chat; el relay reenvía los mensajes sin guardarlos.

### Herramientas de desarrollo

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/project-files.avif" width="48%"><img src="docs/assets/showcase/project-files.avif" alt="Archivos del proyecto" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/git.avif" width="48%"><img src="docs/assets/showcase/git.avif" alt="Cambios de Git" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/terminal.avif" width="48%"><img src="docs/assets/showcase/terminal.avif" alt="Terminal móvil" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/remote-preview.avif" width="48%"><img src="docs/assets/showcase/remote-preview.avif" alt="Vista previa remota" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile-second.svg"><img src="docs/assets/showcase/tools-desktop.svg" alt="" width="100%"></picture>
</p>

- **Archivos del proyecto** — explora el código fuente con resaltado de líneas y descarga o comparte archivos mediante las funciones nativas del sistema.
- **Git** — revisa cambios, añade o retira archivos del área de preparación, descarta cambios, crea commits, envía cambios o publica una rama y explora el gráfico de ramas con diferencias históricas.
- **Terminales** — hasta cinco sesiones de shell por proyecto, compartidas en directo entre dispositivos y restauradas al volver, con una barra de teclas móvil, un control de dirección que repite las pulsaciones al mantenerlo presionado y acelera cuanto más lo arrastras, y desplazamiento suave con inercia.
- **Vista previa de localhost** — abre `http://localhost:3000` (o cualquier puerto local) del ordenador donde se ejecuta el Bridge dentro de la App nativa, tocando un enlace de la Session o introduciendo el puerto, sin SSH, reenvío de puertos ni exposición pública.

### Visualización de contenido

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/permissions.avif" width="48%"><img src="docs/assets/showcase/permissions.avif" alt="Aprobación de permisos" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/mermaid.avif" width="48%"><img src="docs/assets/showcase/mermaid.avif" alt="Diagramas Mermaid" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/inline-html.avif" width="48%"><img src="docs/assets/showcase/inline-html.avif" alt="Vista previa de HTML integrado" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/file-preview.avif" width="48%"><img src="docs/assets/showcase/file-preview.avif" alt="Vista previa de archivos" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile-second.svg"><img src="docs/assets/showcase/rendering-desktop.svg" alt="" width="100%"></picture>
</p>

- **Cronología de ejecución** — llamadas a herramientas y resultados plegables, con la salida completa disponible bajo demanda.
- **Diferencias, Mermaid y LaTeX** — se muestran integrados mientras se recibe la respuesta; copia el código fuente y descarga como imágenes.
- **HTML integrado en las conversaciones** — vistas previas interactivas que se pueden ampliar a pantalla completa sin perder su estado.
- **Vista previa de archivos** — archivos Markdown, HTML, PDF, Office, imágenes y vídeos de proyectos o mensajes; las páginas HTML cargan sus CSS, scripts e imágenes con rutas relativas y se muestran completas sin un servidor local; las imágenes de los mensajes se muestran integradas y se pueden abrir a pantalla completa y ampliar con dos dedos.

### Rápido, estable y ligero

- **Experiencia de App nativa** — la pantalla de inicio nativa da paso sin interrupciones a las pantallas de carga de cada etapa, sin destellos blancos; al deslizar desde el borde para volver, se revela la página anterior.
- **Temas claro y oscuro** — elige Sistema, Claro u Oscuro en Ajustes; la interfaz, el código, los diagramas y la apariencia nativa cambian juntos.
- **Tamaño de página ajustable** — cambia el tamaño de letra en el móvil o usa los atajos de zoom en el escritorio; la elección se conserva entre páginas y al reiniciar la App.
- **Carga instantánea** — las listas, el historial y los datos del proyecto se abren desde la caché local y se actualizan en segundo plano.
- **Transmisión en tiempo real** — las respuestas, el razonamiento y las llamadas a herramientas aparecen a medida que se generan.
- **Entrega estable** — la transmisión ordenada, la reconexión automática y la cola de envíos mantienen la continuidad de las Sessions con redes móviles inestables y después de pasar la App a segundo plano.
- **Apps ligeras** — paquetes nativos pequeños basados en Tauri, además de una App contenedora con ArkWeb para HarmonyOS NEXT.
- **Bridge sin mantenimiento** — funciona de forma permanente en macOS, Linux y Windows, conecta varios ordenadores a una cuenta y se actualiza automáticamente.

### Más funciones

- **Interviene en cualquier momento** — envía mensajes mientras el agente trabaja o interrumpe un turno en curso.
- **Comandos con barra y Skills** — autocompletado con `/` de los comandos integrados y personalizados de cada agente, Skills y prompts guardados.
- **Subagentes** — los subagentes se agrupan bajo su Session principal, con estado en directo.
- **Agentes en segundo plano de Claude** — inícialos de forma remota y sigue su progreso después de desconectarte.
- **Entrada de archivos, imágenes y voz** — adjunta archivos, arrastra archivos o imágenes en el escritorio, envía imágenes comprimidas y dicta mensajes en iOS.
- **Borradores de Session** — conserva el texto y los archivos adjuntos ya subidos al cambiar de Session o volver a abrir la App en el mismo dispositivo.
- **Gestión de Sessions** — cambia el nombre de las Sessions mediante su entorno nativo y mantén pulsado para seleccionar y eliminar varias Sessions o proyectos, con la opción de eliminar también sus archivos locales.
- **Emparejamiento y dispositivos** — añade ordenadores y teléfonos con un código QR, elimina un dispositivo (lo que sustituye la clave de cifrado) y recupera tu cuenta con una frase de recuperación.
- **Rotación de la clave API** — cambia la clave API con `--rotate-key` y conserva los datos existentes.
- **Pestañas en macOS** — trabaja en varias Sessions mediante pestañas independientes.
- **Estadísticas de uso de Claude** — consulta el estado, la configuración, los límites de uso, el historial de tokens y los gráficos de uso de modelos.

---

## Arquitectura

```
┌────────────────┐               ┌──────────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │        Relay         │ ◀────WS─────▶ │     App/Web      │
│ (local hosts)  │               │ API Gateway + Lambda │               │  (phone/desktop) │
└────────────────┘               └──────────┬───────────┘               └──────────────────┘
                                            │
                                            ▼
                                 ┌──────────────────────┐
                                 │ accounts + devices,  │
                                 │ file transfer area   │
                                 └──────────────────────┘
```

- El **Bridge** descubre las Sessions de los agentes, normaliza sus eventos, conserva las relaciones entre agentes principales y subagentes y gestiona el control local de agentes, los archivos del proyecto, los comandos de Git y los procesos de terminal.
- El **Relay** autentica los dispositivos de una misma cuenta y retransmite sus mensajes cifrados de extremo a extremo; solo guarda los registros de cuentas, dispositivos y tokens (las Sessions permanecen en tu ordenador) y una zona temporal de tránsito de archivos.
- La **App/Web** carga el historial en caché, se suscribe a las actualizaciones de las Sessions y los agentes raíz, agrupa los hilos anidados bajo la Session principal y envía las acciones del usuario al entorno local correspondiente.

---

## ¿Por qué Baton?

Baton alude tanto al testigo de una carrera de relevos como a la batuta de un director de orquesta: te permite retomar el trabajo en otro dispositivo y dirigir a tus agentes a distancia.

---

## Desinstalación

### Relay alojado

- **Mover un ordenador a otra cuenta**: ejecuta `node ~/.baton-bridge/bridge.mjs leave` en él.
- **Quitar un ordenador**: mantenlo pulsado en la pantalla de inicio de la App y elige **Remove**; su Bridge se detiene y desactiva el inicio automático.
- **Eliminar la cuenta**: **Settings** → **Delete account**.

### Relay propio

Quita todos los ordenadores y después elimina la pila de CloudFormation.

Para borrar también los archivos del Bridge, consulta la [guía de desinstalación](scripts/uninstall/README.md).

---

## Licencia

MIT
