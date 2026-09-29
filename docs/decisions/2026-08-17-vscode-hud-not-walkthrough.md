# VSCode: HUD, not a separate walkthrough

**Fecha:** 2026-08-17
**Fase del plan:** Fase 2 · D·HUD + walkthrough en VSCode (alcance corregido)
**Estado:** implementado (HUD) — walkthrough reubicado a Fase 2 · E

## Corrección de alcance

El plan pedía "HUD + walkthrough" como si fueran dos features del mismo
tamaño en la extensión de VSCode. Al investigar `panel.ts` resultó que
**la premisa de "walkthrough en VSCode" no aplica**: el panel de la
extensión es, literalmente, un `<iframe src="{serverUrl}?ctxid=...">` — no
renderiza su propio chat ni sus propios diffs, embebe la WebUI entera
(`buildHtml()`, línea ~337). Todo lo que la extensión aporta por su cuenta es
el "chrome" alrededor del iframe: la barra superior (`#bar`), el chip de
adjuntos, el árbol de hooks.

Un "walkthrough" de diffs — agrupar hunks en pasos, explicarlos, navegarlos —
es contenido de la conversación/revisión, que vive DENTRO del iframe (la
superficie de chat de la WebUI), NO en el chrome que esta extensión controla.
Si algún día se construye ahí, VSCode lo hereda gratis, sin escribir una sola
línea en este repo — mismo principio que llevó a reescribir el "paquete UI
compartido" de Fase 1 · F como tokens semánticos en vez de componentes: la
arquitectura ya comparte lo que se puede compartir.

**Importante:** esto NO es lo mismo que Fase 2 · E ("Dashboard de uso").
E es una vista nueva y separada (agregados de tokens/costo), no la superficie
de chat/diffs donde iría un walkthrough. La superficie de chat de la WebUI es
grande y no se investigó en este pase — el walkthrough queda genuinamente
pendiente, sin dueño todavía, hasta que se investigue esa superficie con el
mismo cuidado que el resto de este plan. No se fuerza aquí para no repetir
el error de alcance que ya se corrigió varias veces esta sesión.

## Lo que sí es genuinamente de VSCode: el HUD

La barra superior (`#bar`) es la ÚNICA superficie que el iframe no cubre —
chrome propio de la extensión, sin equivalente compartido. Ahí sí hay trabajo
real y aislado que hacer: un badge de presión de contexto + estado de meta,
igual en espíritu al HUD de Fase 2 · C (CLI), pero con una diferencia de
arquitectura importante:

**Sin evento de "turno completado" que enganchar.** `synapse-cli`'s App.tsx
posee la conexión WS y ve `ws.onComplete` directamente. `panel.ts` NO —
la sesión de chat real vive dentro del iframe, invisible para esta clase.
La única señal recurrente que ya existe es el ping cada 15s
(`startPing`/`ping()`, contra `/api/health`) — el HUD se refresca ahí mismo,
en vez de inventar un segundo timer. `token_status.py` documenta que
`ctx_window` solo cambia una vez por turno de LLM, así que 15s es un
compromiso razonable (no instantáneo como en el CLI, pero sin infraestructura
nueva).

## Cliente REST: se introduce `@synapse/protocol`'s `SynapseRestClient`

`panel.ts` ya hacía llamadas HTTP a mano (`sendMessageWithAttachments`, con
`http.request` + construcción manual de la URL) porque cuando se escribió,
`@synapse/protocol` no tenía un cliente REST tipado que valiera la pena usar.
Ahora sí (Fase 1/2 ya le agregaron `getTokenStatus`/`getSessionGoal`/etc.,
verificados contra el handler Python real) — el HUD lo usa en vez de escribir
un tercer par de llamadas HTTP a mano. Las llamadas viejas no se tocaron
(fuera de alcance de este cambio, no un descuido).

## Contrato visual

- Token pressure: mismos umbrales que el HUD del CLI (≥90% crítico, ≥70%
  advertencia) — misma lectura en ambas superficies.
- Solo se muestra UN badge a la vez si ambos datos están presentes — la
  presión de contexto gana (puede bloquear el siguiente turno; el estado de
  la meta sigue a un `/goal` de distancia en el chat) — el `title` del
  elemento trae ambos para quien pase el mouse.
- Colores via `var(--synapse-warn|error|accent, <hex de respaldo>)` — Fase 1
  · F's tokens compartidos, con el mismo hex ya usado en este archivo como
  respaldo si la variable no resolviera por algún motivo.

## Archivos

- `src/panel.ts` — `SynapseRestClient`, `refreshHud()`, elemento `#hud` +
  estilos + script de render.

## Fuera de alcance (deliberado)

- Walkthrough de diffs — genuinamente pendiente, sin dueño en el plan
  actual. No es trabajo de VSCode (este documento) ni de Fase 2 · E (dashboard
  de uso, una vista distinta) — requiere investigar primero la superficie de
  chat de la WebUI, no investigada en esta sesión.
- Comandos `/goal` dentro del iframe — eso ya lo cubre la Fase 2 · C del CLI
  y (cuando se construya) la propia UI de chat de la WebUI; no hay una
  superficie de composición de mensajes propia de VSCode fuera del iframe
  donde replicarlo tendría sentido.
