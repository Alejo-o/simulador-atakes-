# UmbralSim — Simulador de Predicción de Umbrales frente a Ataques DoS/DDoS

## Propósito
UmbralSim combina mediciones reales autorizadas (análisis forense de logs, métricas Prometheus y sondeo activo de baja intensidad) con un simulador de eventos discretos (DES) en memoria y modelos de teoría de colas (`M/M/1`, `M/M/1/K`, `M/M/c` Erlang C, `M/G/1` Pollaczek-Khinchine y modelo Empírico PCHIP) para predecir la tasa de llegada crítica $\lambda^*$ a partir de la cual se supera un umbral de latencia $T$ o probabilidad de timeout $\varepsilon$, comparando los métodos numéricos **Newton-Raphson** y **Secante** implementados desde cero.

## Ejecución local
1. Instalar dependencias: `npm install`
2. Ejecutar pruebas unitarias, matemáticas y de seguridad: `npm test`
3. Verificar tipos y compilación: `npm run lint && npm run build`
4. Iniciar servidor unificado (Express + WebSocket + Mock Target + Vite en puerto 3000): `npm run dev`
5. Abrir `http://localhost:3000`
