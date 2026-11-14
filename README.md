# Puntualito

Cobranza con CoDi para negocios pequeños (gimnasios, escuelas, talleres, consultorios), a través de la API de Pey.

El comercio crea un cobro, lo comparte como link y el cliente lo paga con QR o con una notificación en la app de su banco. El dinero va directo a la cuenta del negocio; Puntualito nunca lo toca.

## Estado

Esqueleto funcional. **No se ha probado contra Pey ni contra Supabase reales**: pasa pruebas unitarias, TypeScript, compilación y una prueba del SQL en un Postgres local (ver "Validación").

Incluye:

- Motor de cobro: cliente de Pey, webhook firmado, recibos, auditoría.
- Adeudos (`dues`) separados de intentos (`attempts`), con **un solo intento vivo por adeudo**.
- Link público de pago `/pagar/<token>`: QR o push, con estado en vivo.
- Panel del comercio: clientes, crear cobro, lista de pagados y pendientes, botón para enviar el link por WhatsApp (abre `wa.me`, no usa la API de WhatsApp Business).

Pendiente (en orden sugerido):

1. **Verificar el push contra `docs.pey.mx/openapi.json`.** El endpoint `POST /codi/pn` y el evento `codi.pn.payment_received` están implementados con campos tomados de notas de otros equipos del hackatón, no de la referencia oficial. Buscar `POR VERIFICAR` en `src/lib`.
2. Conciliación manual ("Verificar pago") para webhooks perdidos, consultando `GET /transaction/...` en Pey.
3. Recordatorios por WhatsApp de cobros programados: el gancho existe (`onDuesGenerated` y `listReminderCandidates` en `src/lib/reminders.ts`), falta enviar.
4. WhatsApp Business API con botones ("Pagar ahora", "Más tarde", "Prefiero QR").

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
| `PEY_API_KEY_ID` | Identificador de esa key (campo `apiKeyId` en los Webhook Logs de Pey) |
| `PEY_WEBHOOK_SECRET` | Secreto de Standard Webhooks |
| `PEY_MAX_AMOUNT_CENTS` | Tope por cobro en centavos. **Si falta, es 1 ($0.01).** |
| `CRON_SECRET` | Protege `/api/cron/generate-dues`; Vercel Cron lo envía solo |

**No hay sandbox en Pey: los pagos son reales.** Deja `PEY_MAX_AMOUNT_CENTS=1` mientras pruebas y súbelo solo cuando el flujo completo esté verificado.

## Estructura

```
supabase/migrations/     esquema y funciones (toda la lógica de dinero vive en SQL)
src/lib/pey.ts           cliente de Pey: QR y push
src/lib/payment-validation.ts   firma del webhook, montos y contratos
src/lib/attempts.ts      abrir un intento: reservar, llamar a Pey una vez, guardar
src/app/api/webhooks/pey webhook firmado
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
for f in supabase/tests/local_stubs.sql supabase/migrations/*.sql supabase/tests/payment_flow.sql supabase/tests/review_and_plans.sql; do
  psql -v ON_ERROR_STOP=1 -d puntualito_test -f "$f" || break
done
```
