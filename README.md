# Synapse VS Code Extension

Integra Synapse directamente dentro de VS Code. El panel de chat aparece al lado del editor y Synapse sabe automáticamente qué archivo tienes abierto, en qué línea está el cursor y qué errores tiene el linter.

## Instalación

### Opción A — desde el .vsix (recomendado)

```bash
cd C:\Users\ivanh\Agents\synapse-vscode
npm install
npm run package        # genera synapse-vscode-0.1.0.vsix
```

Luego en VS Code: `Ctrl+Shift+P` → **"Extensions: Install from VSIX..."** → selecciona el archivo.

### Opción B — modo desarrollo (sin compilar)

1. Abre la carpeta `synapse-vscode` en VS Code
2. `npm install`
3. Presiona `F5` — abre una ventana de extensión en modo debug

## Uso

1. Arranca Synapse normalmente (`python run_ui.py`)
2. Presiona `Ctrl+Shift+S` (o `Cmd+Shift+S` en Mac) para abrir el panel
3. En el panel aparece la UI de Synapse completa
4. Abre cualquier archivo — la pill en la barra superior muestra qué archivo ve Synapse
5. Escríbele al agente: *"explícame esto"*, *"arregla el error"*, *"refactoriza esta función"*

## Configuración

| Setting | Default | Descripción |
|---------|---------|-------------|
| `synapse.serverUrl` | `http://localhost:5000` | URL del servidor Synapse |
| `synapse.contextId` | *(auto)* | ID de contexto — se guarda automáticamente |
| `synapse.sendEditorContext` | `true` | Enviar archivo activo y cursor |
| `synapse.sendDiagnostics` | `true` | Enviar errores del linter |

## Cómo funciona

- La extensión escucha cambios de archivo, cursor y diagnósticos en VS Code
- Cada 600ms (debounced) envía el estado a `POST /api/editor_context` en Synapse
- El backend lo inyecta como extra en el system prompt del agente en el siguiente turno
- El panel carga la UI de Synapse en un WebView con una barra de estado arriba
