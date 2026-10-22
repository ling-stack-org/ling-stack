<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>Reúne a tus compañeros de IA en un mismo espacio de proyecto local.</strong></p>
  <p>Elige sus modelos y mantén juntas las conversaciones, las aprobaciones de herramientas y los resultados.</p>
  <p>
    <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja-JP.md">日本語</a> · <a href="README.ko-KR.md">한국어</a> ·
    <a href="README.de-DE.md">Deutsch</a> · <a href="README.fr-FR.md">Français</a> ·
    Español · <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <img alt="Alfa desde el código fuente" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="Licencia: MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
</div>

> [!NOTE]
> **Versión alfa que prioriza el uso desde el código fuente.** Empieza con la interfaz Web, el daemon local y la CLI.
> El entorno de desarrollo Desktop está disponible por separado. Todavía no hay instaladores estables y firmados ni una versión de producción con soporte.

## Empieza con una tarea compartida

Al trabajar con varios modelos, las tareas, las respuestas, las solicitudes de herramientas y los resultados pueden acabar en ventanas diferentes.
Ling Stack los reúne en un canal de proyecto: asigna modelos y herramientas a tus compañeros, revisa su actividad y conserva el resultado junto con la conversación.

Prueba una [revisión de documentos de proyecto](docs/community/first-project-review.md) de alcance limitado con dos compañeros y un [ejemplo público](examples/project-review/README.md).
Empieza por la conversación y añade herramientas y permisos cuando una tarea posterior los necesite.
Debes aportar tu propia configuración de proveedor y clave API. Los costes del proveedor corren por tu cuenta.

![Interfaz inglesa de Ling Stack en un espacio de trabajo nuevo](docs/assets/ling-workspace-home.jpg)

Esta captura real muestra la interfaz inglesa de un espacio local nuevo, antes de configurar un modelo.
Ilustra la distribución del espacio, no una tarea terminada. Sigue la guía anterior para probar tu primera colaboración.

## ¿Para quién es Ling Stack?

Ling Stack está pensado para desarrolladores y personas que trabajan con varios modelos o compañeros de IA y quieren mantener su trabajo en un solo lugar.
Un Model Workbench común conecta OpenAI, Anthropic, Volcengine Ark, endpoints compatibles con DeepSeek,
MiniMax, GLM y servicios intermediarios compatibles con OpenAI.

El estado del espacio de trabajo, el historial de conversaciones y las evidencias de ejecución se guardan localmente.
Las solicitudes y su contexto se envían a los proveedores de modelos o herramientas que elijas. **El almacenamiento local no implica inferencia sin conexión.**
La interfaz ofrece 55 opciones de idioma y región. El idioma de la interfaz y el de las respuestas de la IA se configuran por separado.
El README está disponible en los ocho idiomas enlazados arriba. Otros documentos pueden seguir en inglés o chino.

## Tres formas de usarlo

| Escenario | Qué haces | Qué se mantiene junto |
| --- | --- | --- |
| Consultar un modelo | Configurar un modelo de chat y conversar sobre un documento, una idea o un proyecto | Mensajes, selección del modelo, adjuntos y resultados |
| Trabajar con compañeros de IA | Asignar modelos y herramientas y colaborar en un canal de proyecto | Participantes, actividad de herramientas, aprobaciones, archivos generados e informe final |
| Crear contenido multimedia | Configurar una capacidad de imagen o vídeo y utilizar Media Production | Proyectos, escenas, trabajos de generación y resultados |

Empieza con una conversación sencilla y añade compañeros o herramientas según la tarea.
Las skills proporcionan instrucciones, pero no conceden automáticamente acceso a herramientas ni archivos.
Los agentes de programación utilizan el adaptador de ejecución Pi. Las herramientas disponibles dependen de la plataforma y de la política del espacio de trabajo.

## Inicio rápido desde el código fuente

Requisitos: Git, **Node.js 22.22.1 o posterior** y **Corepack con pnpm 10**.
El repositorio fija pnpm `10.0.0`; la versión de referencia de Node en la CI es `22.22.1`.
La compilación de Web y daemon también requiere **Rust 1.89 o posterior y Cargo** para el saneamiento nativo de imágenes.
Instálalos con [rustup](https://rustup.rs/); la CI utiliza Rust `1.97.1`.

### 1. Instalar y compilar

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

Esta compilación incluye la CLI, el daemon, la aplicación Web y sus dependencias internas. Desktop y Mobile requieren una configuración independiente.

### 2. Iniciar el daemon

Ejecuta este comando desde la raíz del repositorio en el primer terminal y déjalo activo:

```bash
corepack pnpm ling daemon start --foreground
```

La dirección predeterminada es `http://127.0.0.1:17891`. Mantén el servicio escuchando en la dirección de bucle local.

### 3. Abrir la interfaz Web

En un segundo terminal, desde la misma raíz del repositorio:

```bash
corepack pnpm ling ui --foreground --open
```

Si el navegador no se abre automáticamente, visita `http://127.0.0.1:5173`.
En otro terminal, `curl http://127.0.0.1:17891/health` debe devolver un JSON con `"ok": true`.
Esto solo confirma que el servicio local está en marcha, no que un modelo esté listo para usar.

### 4. Conectar un modelo y probar una conversación

Abre **Settings → Model Workbench**, añade un modelo de chat con tu propia clave API y ejecuta **Check**.
El primer modelo de chat que supera la comprobación se convierte en el predeterminado del espacio de trabajo.
Haz una pregunta breve en una conversación nueva y revisa la respuesta y sus detalles.

Después de configurar y comprobar el modelo, ejecuta:

```bash
corepack pnpm ling doctor
```

Doctor comprueba la disponibilidad del modelo y el estado de los servicios locales.
Un espacio nuevo sin modelo de chat muestra un fallo del proveedor aunque el daemon y la interfaz Web estén funcionando.
La [guía de inicio](docs/getting-started.md) explica el primer modelo, la conversación y el canal de proyecto. Consulta la [solución de problemas](docs/troubleshooting.md) si falla la configuración.

## Soporte y limitaciones

| Componente o integración | Alcance actual |
| --- | --- |
| Web, daemon y CLI | Alfa desde el código fuente; vía de inicio predeterminada |
| Electron Desktop | Entorno de desarrollo; preparación de plataforma y validación en un equipo limpio son pasos separados |
| Extensión de Chrome y Browser Host | Integración de desarrollo local; publicación en Chrome Web Store pendiente |
| MCP y Plugin Manager | Asignación explícita de herramientas, activación y límites de aprobación |
| Funciones nativas de Office y Computer Use | Desarrollo dependiente de la plataforma; consultar los criterios de implementación y publicación |
| Generación de imágenes y vídeo | Depende del proveedor y de las capacidades; algunos adaptadores reales aún requieren validación |
| Mobile | Desarrollo experimental fuera del alcance actual de aceptación del producto |

La ejecución nativa, la accesibilidad, la firma y la validación de instaladores siguen pendientes para ciertas funciones.
El [estado de implementación](docs/design/implementation-status.md) recoge lo implementado y las comprobaciones restantes.
Una compilación o un test específico satisfactorio no demuestra que un instalador esté listo.

Para preguntas y errores reproducibles, lee la [guía de soporte](SUPPORT.md) y utiliza los [formularios de GitHub Issues](https://github.com/ling-stack-org/ling-stack/issues/new/choose).
El mantenimiento se presta según los recursos disponibles. Informa de vulnerabilidades por el [canal de seguridad](SECURITY.md), sin publicar datos sensibles en issues públicas.

### Desarrollo Desktop

En macOS hacen falta las Xcode Command Line Tools con Swift y `codesign`.
En Windows, el controlador de Office requiere el SDK de .NET 8. Los destinos de distribución actuales son macOS arm64 y Windows x64.
Electron también necesita el binario de su plataforma; consulta la [solución de problemas de Desktop](docs/troubleshooting.md#desktop-development).

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

Las herramientas, los comandos de compilación y las pruebas manuales se describen en la [guía de paquetes de desarrollo para Mac y Windows](docs/release/development-packages.md).
Antes de empaquetar para distribuir, lee las [reglas de publicación y aceptación de Desktop](docs/release/desktop.md).
Publicar el código fuente y publicar binarios firmados son pasos diferentes.

## Datos y permisos

Los datos del espacio se guardan por defecto en `.ling-stack/`, incluidos `ling-stack.sqlite`, `sessions/`, `artifacts/` y `logs/`.
Las claves API introducidas en Model Workbench se almacenan en el espacio de trabajo local.
También se admiten variables de entorno y referencias a almacenes de claves compatibles; consulta [configuración y datos](docs/getting-started.md#configuration-and-data).

No incluyas claves, bases de datos, registros de sesión ni resultados privados en Git o en informes públicos.
Los permisos del espacio regulan el acceso a archivos, los comandos shell, las modificaciones externas y la generación de pago.
Revisa las solicitudes antes de aprobarlas. Para migrar el almacenamiento, utiliza las [operaciones de almacenamiento de la CLI](docs/design/workspace-state-storage.md).

## Explorar y contribuir

Si este flujo de trabajo te resulta útil, añade una estrella al repositorio para seguir su evolución.
Cuéntanos en los [formularios de Issues](https://github.com/ling-stack-org/ling-stack/issues/new/choose) qué probaste, dónde te atascaste y si el resultado te ayudó.

Web (`apps/web`), Desktop (`apps/desktop`) y CLI (`packages/cli`) comparten el daemon (`packages/daemon`).
La lógica de dominio, los contratos, los adaptadores de proveedores y las integraciones de ejecución están en `packages/`.

- [Guía de contribución](CONTRIBUTING.md) y [normas de traducción de README](CONTRIBUTING.md#readme-translations): entorno, comprobaciones y correcciones lingüísticas.
- [Primera revisión de proyecto](docs/community/first-project-review.md) y [materiales comunitarios](docs/community/launch-kit.md): colaboración y comentarios.
- [Arquitectura](docs/architecture.md) y [Daemon API](docs/daemon-api.md): límites del sistema.
- [Índice de diseño](docs/design/README.md) y [estado de implementación](docs/design/implementation-status.md): contratos vigentes y criterios de aceptación.
- [Adaptadores de proveedores](docs/provider-adapters.md) e [integración Pi](docs/pi-coding-agent-integration.md): modelos y ejecución.
- [Política de publicación](docs/release/README.md), [registro de cambios](CHANGELOG.md) y [avisos de terceros](THIRD_PARTY_NOTICES.md).

Ling Stack está disponible bajo la [licencia MIT](LICENSE). La participación en la comunidad se rige por el [código de conducta](CODE_OF_CONDUCT.md).
