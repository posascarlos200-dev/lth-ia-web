# LTH IA · Mady (web)

Web móvil/PC para chatear con **Mady**, la asistente de LTH OS. Sitio estático
(sin build): HTML + CSS + JS puro. Se conecta a Supabase (auth + edge function
`lth-ia-cloud`) y sincroniza el historial con la app de escritorio y LTH Remote.

## Características
- Login y registro abierto (Supabase email/password). Nuevos usuarios entran con plan **free**.
- Chat con Mady en **streaming** (token a token).
- **Barra de uso** siempre visible (uso de la ventana actual); detalle semanal/mensual en el panel.
- Historial sincronizado (tabla `ia_conversations`) entre PC, teléfono y esta web.
- Responsive: sidebar fija en PC, drawer en teléfono.
- Instalable como **PWA**.

## Desplegar
Es un sitio 100% estático. En Vercel: importar este repo y desplegar (sin configuración).
Para probar local:
```
npx serve .
```

## Configuración
`config.js` contiene la URL y la *publishable key* de Supabase (claves públicas de
cliente, seguras de exponer). La seguridad real vive en las RLS de Supabase y en la
edge function (que valida el JWT del usuario).
