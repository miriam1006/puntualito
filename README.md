# Puntualito

Cobranza con CoDi para negocios pequeños (gimnasios, escuelas, talleres, consultorios), a través de la API de Pey.

El comercio crea un cobro, lo comparte como link y el cliente lo paga con QR o con una notificación en la app de su banco. El dinero va directo a la cuenta del negocio; Puntualito nunca lo toca.

## Estado

Esqueleto funcional. **No se ha probado contra Pey ni contra Supabase reales**: pasa pruebas unitarias, TypeScript, compilación y una prueba del SQL en un Postgres local (ver "Validación").

Incluye:

- Motor de cobro: cliente de Pey, webhook firmado, recibos, auditoría.
- Adeudos (`dues`) separados de intentos (`attempts`), con **un solo intento vivo por adeudo**.
- Link público de pago `/pagar/<token>`: QR o push, con estado en vivo.
- Panel del comercio: clientes, crear cobro, lista de pagados y pendientes, historial de WhatsApp por cobro y botón `wa.me` de respaldo.
- WhatsApp Business (Cloud API): plantilla con "Pagar ahora", "Más tarde" y "Prefiero QR" al crear el cobro, QR por WhatsApp, "Pago recibido" y estados de entrega. Ver "WhatsApp Business".

Pendiente (en orden sugerido):

1. ~~Verificar el push contra `docs.pey.mx/openapi.json`~~. Hecho: `POST /codi/pn` y `codi.pn.payment_received` coinciden con la referencia oficial (copia en `docs/pey-openapi.json`, versión 2026-10-20). Falta probarlo con un celular real.
2. ~~Conciliación manual~~. Hecho: botón "Verificar pago" en el panel → `POST /api/dues/<id>/verify`, que consulta `GET /transaction/{id}` (push) o `GET /transaction/codi/qr/{id}` (QR) y registra el pago por `process_pey_payment` con `webhook_id` `reconcile:<transactionId>`.
3. ~~Cobros programados y recordatorios~~. Hecho: Vercel Cron genera los adeudos de los planes, envía la plantilla de cobro nuevo por WhatsApp (`onDuesGenerated`) y procesa los recordatorios "Más tarde" vencidos (`reminder_requests`).
4. WhatsApp Business: aprobar las plantillas en Meta y probar con el número de prueba (no se ha probado contra Meta real). Sin las variables `WHATSAPP_*` el cron solo registra en logs.
5. ~~Pantalla para resolver adeudos "Por revisar" y editar o dar de baja clientes~~. Hecho: `/revisar` y `/clientes`.

## Por revisar y cobros programados

- **`/revisar`:** adeudos con pago repetido, monto distinto o pagados después de cancelar, con sus recibos. Acciones (función `resolve_due`, con auditoría): *Marcar como pagado*, *Requiere reembolso* (nota obligatoria; sigue en revisión) y *Cerrar revisión* (queda pagado si ya tenía un pago válido; si no, cancelado).
- **`/clientes`:** editar (`update_customer`) y dar de baja (`deactivate_customer`, detiene sus planes) clientes; programar cobros semanales o mensuales por cliente (`create_plan`, `deactivate_plan`).
- **Generación:** `generate_due_dues` crea los adeudos vencidos de los planes activos. Es idempotente (`unique (plan_id, due_date)`) y recupera hasta 12 periodos atrasados. La corre Vercel Cron a diario (`vercel.json`, 13:00 UTC = 7:00 en CDMX) en `/api/cron/generate-dues` con `CRON_SECRET`, y el botón "Generar cobros ahora" del panel para la demo.

## Cómo funciona un cobro

1. El comercio crea un **adeudo** (cliente opcional, concepto, monto). Nace con un token público de 64 caracteres.
2. El cliente abre `/pagar/<token>` y elige **QR** o **Enviar a la app de mi banco** (push; solo si el comercio registró su celular).
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

Aplicar también `supabase/migrations/202611140003_whatsapp.sql` (tablas `whatsapp_messages` y `reminder_requests`).

Flujo:

1. Al crear un cobro para un cliente con celular **y con "Aceptó recibir cobros por WhatsApp"**, se manda la plantilla de cobro nuevo (después de responder al panel).
2. "Pagar ahora" abre `/pagar/<token>`. "Prefiero QR" abre un intento QR en Pey y responde con la imagen del QR. "Más tarde" guarda una fila en `reminder_requests` (para mañana) y confirma por texto.
3. Cuando `process_pey_payment` marca el cobro pagado, se manda "Pago recibido".
4. Los estados de Meta (enviado, entregado, leído, falló) se guardan y el panel los muestra por cobro.

Configuración en Meta for Developers:

1. Crear una app tipo Business, agregar el producto WhatsApp y usar el número de prueba. Registrar ahí hasta 5 celulares destinatarios (los de la demo).
2. Copiar el Phone number ID a `WHATSAPP_PHONE_NUMBER_ID`. Para el token, crear un usuario del sistema en Business Settings con permisos `whatsapp_business_messaging` y `whatsapp_business_management` y generar un token permanente (el temporal vence en 24 h) para `WHATSAPP_ACCESS_TOKEN`.
3. App Settings → Basic → App Secret a `WHATSAPP_APP_SECRET`.
4. WhatsApp → Configuration → Webhook: URL `https://TU-DOMINIO/api/webhooks/whatsapp`, Verify token igual a `WHATSAPP_VERIFY_TOKEN`; suscribir el campo `messages`.
5. Plantillas (categoría Utility, idioma Español (MEX) `es_MX`), con los parámetros en este orden:
   - Cobro nuevo y recordatorio: cuerpo con `{{1}}` cliente, `{{2}}` negocio, `{{3}}` concepto, `{{4}}` monto. Botones en este orden: 0 = URL "Pagar ahora" dinámica `https://TU-DOMINIO/pagar/{{1}}`, 1 = respuesta rápida "Más tarde", 2 = respuesta rápida "Prefiero QR".
   - Pago recibido: cuerpo con `{{1}}` concepto, `{{2}}` monto, `{{3}}` negocio. Sin botones.

El texto libre (respuestas, QR) solo llega si el cliente escribió o tocó un botón en las últimas 24 h; por eso "Pago recibido" usa plantilla cuando está configurada.

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
