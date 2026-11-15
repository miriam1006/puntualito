# Puntualito

**Cobranza recurrente con CoDi para negocios pequeños, sin comisiones y sin que el cliente tenga que descargar nada.**

Demo en producción: **https://puntualito.vercel.app** · Hackatón México 2026 · API de Pey

## El problema

Gimnasios, consultorios de ortodoncia, servicios de mantenimiento, escuelas de música y otros negocios con mensualidades cobran mes a mes por transferencia o en efectivo. Persiguen pagos por WhatsApp, revisan capturas de transferencias a mano y pagan comisiones de terminal cuando aceptan tarjeta.

## La solución

El negocio registra al cliente una vez y Puntualito cobra cada periodo con **CoDi**:

1. El negocio toca **Cobrar** (o el cobro se genera solo con la mensualidad programada).
2. Al cliente le llega una **notificación de CoDi en la app de su banco**: monto, concepto y negocio. La autoriza y listo.
3. Pey confirma el pago con un webhook firmado y el panel lo marca **Pagado** con su recibo, sin conciliar a mano.

El dinero va directo de la cuenta del cliente a la del negocio: **CoDi no cobra comisión** y Puntualito nunca toca el dinero.

## Qué funciona hoy en producción

- **Cobro CoDi real con Pey:** push a la app del banco (`POST /codi/pn`) y QR como respaldo (`POST /codi/qr`).
- **Reacción al pago:** webhook firmado de Pey → el cobro pasa a *Pagado* con recibo y auditoría. "Verificar pago" consulta a Pey si un webhook se pierde.
- **Panel del negocio:** cobrar a un cliente nuevo o existente en un paso; pendientes, pagados y casos *Por revisar* (pago repetido o monto distinto; nunca se descarta dinero recibido).
- **Mensualidades programadas:** semanales o mensuales por cliente; un cron diario genera los cobros.
- **Seguridad:** un solo intento de cobro vivo por adeudo (evita cobrar dos veces), tope de monto configurable, firma de webhooks y RLS en Supabase.

## WhatsApp (integración lista, pendiente de Meta)

El canal pensado para el cliente es WhatsApp: un mensaje del negocio con dos botones, **Pagar ahora** (dispara el push de CoDi) y **Más tarde** (agenda un recordatorio), y el comprobante "¡Pago recibido!" al final. Todo por chat, sin links ni apps nuevas.

El código está terminado y probado (plantillas con botones, webhook de Meta con verificación de firma, respuestas a cada botón). La cuenta de WhatsApp Business está **en verificación de negocio por Meta** (hasta 14 días hábiles), así que todavía no puede enviar mensajes.

Mientras tanto, cada cobro tiene **"Vista del cliente (demo)"**: muestra la conversación tal como la verá el cliente, y sus botones usan el mismo flujo real. «Pagar ahora» manda el push CoDi verdadero con Pey.

## Cómo probarlo

1. Entra a https://puntualito.vercel.app con el usuario de prueba (viene en el formulario de entrega).
2. En **Nuevo cobro**, elige "+ Cliente nuevo", escribe tu celular (con CoDi activado en tu banco), un concepto y **$0.01**, y toca **Cobrar**.
3. Autoriza la notificación en la app de tu banco. En unos segundos el cobro aparece como **Pagado**.
4. Abre "Vista del cliente (demo)" en un cobro pendiente para ver la experiencia por WhatsApp.

> Los cobros son reales (Pey no tiene sandbox). El servidor tiene un tope de monto para pruebas.

## Siguiente paso: facturación automática

Que cada pago con CoDi genere su **recibo o factura (CFDI)** sin capturar nada: los datos fiscales del cliente se guardan una vez y la factura se timbra y se manda por WhatsApp al confirmarse el pago.

## Stack

Next.js (App Router) + TypeScript · Supabase (Postgres, RLS, funciones SQL) · API de Pey (CoDi) · WhatsApp Cloud API · Vercel (hosting y cron).

---

# Detalles técnicos

## Estado de las piezas

- Probado en producción con Pey real: push, QR, webhook y "Pagado".
- WhatsApp Business: implementado y con pruebas unitarias; no se ha probado contra Meta real porque la cuenta está en verificación. Sin las variables `WHATSAPP_*`, el servidor solo lo registra en logs.

## Por revisar y cobros programados

- **`/revisar`:** adeudos con pago repetido, monto distinto o pagados después de cancelar, con sus recibos. Acciones (función `resolve_due`, con auditoría): *Marcar como pagado*, *Requiere reembolso* (nota obligatoria; sigue en revisión) y *Cerrar revisión* (queda pagado si ya tenía un pago válido; si no, cancelado).
- **`/clientes`:** editar (`update_customer`) y dar de baja (`deactivate_customer`, detiene sus planes) clientes; programar cobros semanales o mensuales por cliente (`create_plan`, `deactivate_plan`).
- **Generación:** `generate_due_dues` crea los adeudos vencidos de los planes activos. Es idempotente (`unique (plan_id, due_date)`) y recupera hasta 12 periodos atrasados. La corre Vercel Cron a diario (`vercel.json`, 13:00 UTC = 7:00 en CDMX) en `/api/cron/generate-dues` con `CRON_SECRET`, y el botón "Generar cobros ahora" de Clientes y planes para la demo.

## Cómo funciona un cobro

1. El comercio crea un **adeudo** (cliente, concepto, monto) con "Cobrar", o lo genera un plan programado. Nace con un token público de 64 caracteres.
2. Se pide el pago: push al celular del cliente ("Cobrar" en el panel o "Pagar ahora" en WhatsApp) o QR ("Mostrar QR" o "Enviar QR").
3. El servidor reserva un **intento** y hace una sola llamada a Pey. Mientras ese intento esté vivo (10 min el QR, 6 min el push) no se crea otro para el mismo adeudo.
4. Pey confirma el pago con un webhook firmado. La función `process_pey_payment` registra el recibo y marca intento y adeudo como pagados en una sola transacción.
5. La página pública y el panel consultan el estado y muestran "Pago recibido".

Casos raros:

- **Pago repetido o monto distinto:** se registra el recibo y el adeudo pasa a "Por revisar". Nunca se descarta dinero recibido.
- **Pago tardío** (después de vencer el intento): si el adeudo sigue abierto, se marca pagado.
- **Timeout al llamar a Pey:** resultado incierto. El intento queda reservado hasta vencer y no se crea otro, para no duplicar cobros. Si el pago llega, el webhook lo recupera por `numRef`.
- **Cancelar un adeudo** no invalida el QR o push en Pey. Un pago posterior queda "Por revisar".

## Configurar

Requiere Node.js 22.

```bash
npm install
cp .env.example .env.local   # completar; nunca subirlo a git
npm run dev
```

1. **Supabase:** crear un proyecto nuevo y ejecutar en orden las migraciones de `supabase/migrations/` en el SQL Editor. Crear un usuario en Authentication → Users (confirmado) y poner su correo en `OWNER_EMAIL`.
2. **Pey:** crear una API key nueva en el portal (Desarrollador). Una key tiene un solo webhook, así que no reutilices la de otro proyecto.
3. **Desplegar en Vercel** con las variables de `.env.example` y `APP_URL` igual al dominio HTTPS, sin barra final.
4. **Webhook:** en Pey → Desarrollador → engrane de la key, registrar `https://TU-DOMINIO/api/webhooks/pey`, crear el secreto y guardarlo en `PEY_WEBHOOK_SECRET`. Redesplegar.
5. Entrar en `/login`, crear el negocio y hacer un cobro de **$0.01**.

### Variables

| Variable | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Proyecto de Supabase (sesión) |
| `SUPABASE_SECRET_KEY` | Clave de servicio; solo servidor |
| `OWNER_EMAIL` | Correo autorizado para crear el primer comercio |
| `APP_URL` | Origen del despliegue; se usa para validar el origen de las peticiones |
| `PEY_API_KEY` | Clave secreta de Pey |
| `PEY_API_KEY_ID` | Identificador de esa key (`apiKeyId`). Puede quedar vacía al inicio (ver abajo) |
| `PEY_WEBHOOK_SECRET` | Secreto de Standard Webhooks |
| `PEY_MAX_AMOUNT_CENTS` | Tope por cobro en centavos. **Si falta, es 1 ($0.01).** |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Número de WhatsApp y token de Meta. Si falta alguno, no se envía nada (queda `wa.me`) |
| `WHATSAPP_APP_SECRET` | App Secret de Meta; verifica `X-Hub-Signature-256` del webhook |
| `WHATSAPP_VERIFY_TOKEN` | Texto libre para el handshake al registrar el webhook |
| `WHATSAPP_TEMPLATE_NEW_DUE`, `WHATSAPP_TEMPLATE_REMINDER`, `WHATSAPP_TEMPLATE_PAYMENT_RECEIVED` | Nombres de plantillas aprobadas. Sin la de cobro nuevo no se envía el cobro; sin la de pago recibido se manda texto (solo llega dentro de las 24 h) |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Idioma de las plantillas; por omisión `es_MX`. Opcional: `WHATSAPP_GRAPH_VERSION` (por omisión `v23.0`) |
| `CRON_SECRET` | Protege `/api/cron/generate-dues`; Vercel Cron lo envía solo |

**`PEY_API_KEY_ID` sin configurar.** El portal de Pey no muestra el `apiKeyId` y ningún endpoint de la API lo devuelve; solo llega en los webhooks firmados (`codi.qr.payment_received`, `codi.pn.payment_received`, y como `ownerId` en `bank.account.updated`). Por eso, sin esa variable:

- Se puede crear el negocio (queda sin `pey_api_key_id`) y crear cobros, QR y push.
- El webhook sigue exigiendo la firma (`PEY_WEBHOOK_SECRET`). Con la firma válida escribe en los logs `PEY_API_KEY_ID no configurado; apiKeyId recibido: ...`, guarda el evento en `webhook_events` (`outcome = 'held'`), liga ese `apiKeyId` al negocio dueño del intento si aún no tenía uno, y responde 503 **sin marcar el cobro como pagado**, para que Pey reintente.
- Copia ese valor a `PEY_API_KEY_ID` en Vercel y redespliega. El siguiente reintento de Pey o "Verificar pago" registra el pago. Si el negocio se creó sin ID, se liga a `PEY_API_KEY_ID` en cuanto el dueño abre el panel.
- Un negocio ya ligado nunca cambia de `apiKeyId`; con la variable configurada, un webhook con otro `apiKeyId` se rechaza (401) y "Verificar pago" exige que coincidan.

Requiere la migración `202611140004_pey_api_key_optional.sql`.

**No hay sandbox en Pey: los pagos son reales.** Deja `PEY_MAX_AMOUNT_CENTS=1` mientras pruebas y súbelo solo cuando el flujo completo esté verificado.

## WhatsApp Business

Aplicar también `supabase/migrations/202611140003_whatsapp.sql` (tablas `whatsapp_messages` y `reminder_requests`) y `202611150001_whatsapp_pay_now.sql` (registra el botón "Pagar ahora").

Flujo:

1. Al crear un cobro para un cliente con celular **y con "Aceptó recibir cobros por WhatsApp"**, se manda la plantilla de cobro nuevo (después de responder al panel).
2. El cliente hace todo desde el chat, sin abrir links:
   - **"Pagar ahora"** abre un intento push en Pey: le llega la notificación de CoDi a la app de su banco (al celular registrado por el negocio). El chat le confirma y, si no le llegó, le pide activar CoDi en su banco y volver a tocar "Pagar ahora", con un botón **"Enviar QR"** como último recurso.
   - **"Enviar QR"** (solo en las respuestas, no en la plantilla) abre un intento QR en Pey y responde con la imagen, para escanearla desde otra pantalla o leerla desde la galería. Mientras el push siga vigente no se crea el QR (un solo intento vivo por adeudo); el chat le dice en cuántos minutos vence.
   - **"Más tarde"** guarda una fila en `reminder_requests` (para mañana) y confirma con un botón "Pagar ahora".

   El chat nunca manda links.

   Las respuestas con botones son mensajes interactivos: como el texto libre, solo llegan dentro de las 24 h posteriores a que el cliente tocó un botón, que es justo cuando se mandan. La página `/pagar/<token>` queda como respaldo (botón `wa.me` del panel o cuando no hay plantillas).
3. Cuando `process_pey_payment` marca el cobro pagado, se manda "Pago recibido".
4. Los estados de Meta (enviado, entregado, leído, falló) se guardan y el panel los muestra por cobro.

Configuración en Meta for Developers:

1. Crear una app tipo Business, agregar el producto WhatsApp y usar el número de prueba. Registrar ahí hasta 5 celulares destinatarios (los de la demo).
2. Copiar el Phone number ID a `WHATSAPP_PHONE_NUMBER_ID`. Para el token, crear un usuario del sistema en Business Settings con permisos `whatsapp_business_messaging` y `whatsapp_business_management` y generar un token permanente (el temporal vence en 24 h) para `WHATSAPP_ACCESS_TOKEN`.
3. App Settings → Basic → App Secret a `WHATSAPP_APP_SECRET`.
4. WhatsApp → Configuration → Webhook: URL `https://TU-DOMINIO/api/webhooks/whatsapp`, Verify token igual a `WHATSAPP_VERIFY_TOKEN`; suscribir el campo `messages`.
5. Plantillas (categoría Utility, idioma Español (MEX) `es_MX`), con los parámetros en este orden:
   - Cobro nuevo y recordatorio: cuerpo con `{{1}}` cliente, `{{2}}` negocio, `{{3}}` concepto, `{{4}}` monto. Dos botones de **respuesta rápida**, en este orden: 0 = "Pagar ahora", 1 = "Más tarde". Ninguno es de tipo URL.
   - Pago recibido: cuerpo con `{{1}}` concepto, `{{2}}` monto, `{{3}}` negocio. Sin botones.

El texto libre (respuestas, QR) solo llega si el cliente escribió o tocó un botón en las últimas 24 h; por eso "Pago recibido" usa plantilla cuando está configurada.

## Vista previa del chat de WhatsApp (`/chat/<token>`)

Mientras Meta verifica el negocio (sin verificación, la cuenta de WhatsApp no envía mensajes; error 131031), cada cobro se puede probar en una vista previa del chat: botón **"Ver chat de WhatsApp"** en el panel.

- Se ve como el chat de WhatsApp: mensaje del cobro con **"Pagar ahora"** y **"Más tarde"**.
- Los botones usan exactamente las mismas respuestas que el webhook de Meta (`src/lib/chat-flow.ts`). **"Pagar ahora" manda el push de CoDi real con Pey** al celular registrado del cliente; "Enviar QR" genera el QR real; "Más tarde" agenda el recordatorio.
- El pago lo confirma el webhook de Pey como siempre; el chat consulta el estado y muestra "¡Pago recibido!".
- Expone lo mismo que el link público (negocio, concepto y monto), nunca el nombre del cliente.

Lo único simulado es el canal: el mensaje se ve en esta página y no en la app de WhatsApp.

## Ramas

- `main`: versión estable, la que se despliega.
- Cada función entra con su rama `feat/<función>` y un merge `--no-ff` a `main`, para que el historial muestre qué trajo cada una:
  - `feat/visual-polish`: ajustes visuales del panel y del link de pago, y el botón "Pagar ahora" por WhatsApp (respuesta rápida que manda el push).
  - `feat/whatsapp-simulator`: vista previa del chat (`/chat/<token>`) y lógica de respuestas compartida (`lib/chat-flow.ts`).
  - Anteriores: `feat/pey-push-reconcile`, `feat/review-plans`, `feat/whatsapp`.

## Estructura

```
supabase/migrations/     esquema y funciones (toda la lógica de dinero vive en SQL)
src/lib/pey.ts           cliente de Pey: QR y push
src/lib/payment-validation.ts   firma del webhook, montos y contratos
src/lib/attempts.ts      abrir un intento: reservar, llamar a Pey una vez, guardar
src/app/api/webhooks/pey webhook firmado
src/lib/whatsapp.ts      cliente de WhatsApp Cloud API: plantillas, texto, imagen
src/lib/whatsapp-webhook.ts     firma X-Hub-Signature-256 y parseo de eventos de Meta
src/lib/whatsapp-notify.ts      envíos al crear y pagar, respuestas a botones
src/lib/chat-flow.ts            respuestas del chat (Pagar ahora, Más tarde, QR), compartidas con la vista previa
src/app/chat/[token]            vista previa del chat de WhatsApp
src/app/api/webhooks/whatsapp   webhook de Meta (handshake GET y eventos POST)
src/app/api/pay/[token]  API pública del link de pago
src/app/pagar/[token]    página pública de pago
src/app/page.tsx         panel del comercio
```

## Seguridad

- Las tablas tienen RLS activo y sin políticas: el navegador nunca las lee; todo pasa por el servidor.
- El link público solo muestra negocio, concepto, monto y los dos últimos dígitos del celular.
- El push solo se envía al celular que registró el comercio, nunca a uno escrito en la página pública.
- El webhook verifica la firma sobre el body crudo antes de leerlo y descarta `metadata` (puede traer la CLABE).

## Validación

```bash
npm run typecheck
npm test
npm run build

# SQL en un Postgres local (no Supabase): stubs, migraciones en orden y pruebas (terminan en ROLLBACK)
for f in supabase/tests/local_stubs.sql supabase/migrations/*.sql supabase/tests/payment_flow.sql supabase/tests/review_and_plans.sql supabase/tests/whatsapp_flow.sql supabase/tests/pey_api_key_binding.sql; do
  psql -v ON_ERROR_STOP=1 -d puntualito_test -f "$f" || break
done
```
