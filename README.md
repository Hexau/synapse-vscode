# Synapse VS Code Extension

Integra [Synapse](https://github.com/Hexau/team-agent-synapse) directamente
dentro de VS Code. El panel de chat aparece al lado del editor y Synapse
sabe automáticamente qué archivo tenés abierto, en qué línea está el
cursor y qué errores tiene el linter. Es, técnicamente, un webview que
embebe la WebUI del backend — cualquier feature nueva del lado del
servidor (como el panel "Dev Tools") aparece acá sola, sin tocar código
de esta extensión.

Para levantar el backend, ver
[docs/ECOSYSTEM-SETUP.md](https://github.com/Hexau/team-agent-synapse/blob/main/docs/ECOSYSTEM-SETUP.md)
en el repo principal.

## Instalación

### Opción A — desde el .vsix (recomendado)

```bash
npm install
npm run compile
npx vsce package        # genera synapse-vscode-0.1.0.vsix
```

Luego en VS Code: `Ctrl+Shift+P` → **"Extensions: Install from VSIX..."** → selecciona el archivo.

### Opción B — modo desarrollo (sin empaquetar)

1. Abrí la carpeta `synapse-vscode` en VS Code.
2. `npm install`.
3. Presioná `F5` — abre una ventana de extensión en modo debug.

`@synapse/protocol` y `@synapse/tokens` se consumen como `.tgz`
vendorizados en `vendor/` — si cambiaron, hace falta repackearlos y
reinstalar desde cero (ver la guía de ambientación linkeada arriba).

## Uso

1. Arrancá el backend (Docker o `python run_ui.py` — ver la guía de
   ambientación).
2. Presioná `Ctrl+Shift+S` (`Cmd+Shift+S` en Mac), o abrí el panel
   "Synapse" en la barra de actividad.
3. La primera vez, si el backend corre en modo multiusuario, configurá tu
   token con **"Synapse: Set API Token"** (lo sacás de `/api/my_account`
   después de loguearte en la WebUI).
4. Abrí cualquier archivo — la extensión le manda al agente qué archivo
   ves y en qué línea, y sus diagnósticos de linter.
5. Adjuntá un archivo a la conversación con **"Synapse: Attach File to
   Chat"** (o el ícono de clip en la vista de chat).

### Panel de Agent Hooks

La barra lateral de Synapse tiene una segunda vista, **"Agent Hooks"**,
para listar, correr, duplicar y editar hooks del agente (tanto los
built-in como los de tu proyecto) sin salir de VS Code.

## Configuración

| Setting | Default | Descripción |
|---------|---------|-------------|
| `synapse.serverUrl` | `http://localhost:5000` | URL del servidor Synapse (usá `http://localhost:50080` si corrés el backend con Docker) |
| `synapse.contextId` | *(auto)* | ID de contexto — se guarda automáticamente |
| `synapse.apiToken` | *(vacío)* | Token de API — requerido en modo multiusuario |
| `synapse.sendEditorContext` | `true` | Enviar archivo activo y cursor |
| `synapse.sendDiagnostics` | `true` | Enviar errores del linter |

## Cómo funciona

- La extensión escucha cambios de archivo, cursor y diagnósticos en VS Code.
- Cada 600ms (debounced) envía el estado como contexto extra al backend.
- El panel carga la WebUI de Synapse en un webview — el mismo frontend
  que ves en el navegador, con una pill de estado arriba.
- El panel de hooks y la cola de adjuntos hablan por el REST client de
  `@synapse/protocol`, no reimplementan su propio wire format.
