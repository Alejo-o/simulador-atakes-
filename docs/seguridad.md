# Controles de Seguridad y Protección SSRF — UmbralSim

1. **Límites duros inmutables (`server/core/safetyLimits.ts`)**: Máximo 5 req/s, 60 s por sondeo, concurrencia máxima 2, solo `GET`/`HEAD` sin cuerpo, 1 prueba simultánea por objetivo y enfriamiento obligatorio de 5 minutos.
2. **Autorización y verificación de propiedad (`server/adapters/ownership.ts`)**: Exige casilla explícita, registro de autorización con fecha de expiración y verificación mediante `/.well-known/umbral-verify.txt`, registro DNS TXT o cabecera `X-UmbralSim-Verify` (excepción de verificación de dominio para loopback/redes privadas, manteniendo casilla y registro).
3. **Protección SSRF (`server/adapters/ssrfGuard.ts`)**: Resolución DNS previa a cada petición y tras cada redirección, bloqueo permanente de IPs de metadatos cloud (`169.254.169.254` y equivalentes), bloqueo de redirecciones entre hosts y bloqueo de IPs privadas/loopback salvo autorización local explícita.
4. **Auto-abortos y políticas**: Respeto de `robots.txt`, cabecera identificable `UmbralSim/1.0`, aborto inmediato ante HTTP `429`/`503` o si `p95 > 3×` línea base.
5. **Auditoría encadenada (`server/core/audit.ts`)**: Registro inmutable encadenado por SHA-256 (`prev_hash → hash`) verificable desde la interfaz y pruebas automatizadas.
