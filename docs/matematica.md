# Fundamento Matemático — UmbralSim

## Modelos de Colas
1. **M/M/1**: $W(\lambda) = \frac{1}{\mu - \lambda}$ para $\lambda < \mu$, con derivada analítica $W'(\lambda) = \frac{1}{(\mu - \lambda)^2}$. Percentil $p$: $W_p(\lambda) = \frac{-\ln(1-p)}{\mu - \lambda}$. Probabilidad de timeout: $P(W > T) = e^{-(\mu - \lambda)T}$.
2. **M/M/1/K**: Capacidad finita $K$, probabilidad de bloqueo $P_B = \frac{(1-\rho)\rho^K}{1-\rho^{K+1}}$ (con caso $\rho=1 \implies P_B = \frac{1}{K+1}, W = \frac{K+1}{2\mu}$).
3. **M/M/c (Erlang C)**: $c$ servidores, cálculo recursivo estable de $B(c, a)$ y $C(c, a)$, sin derivada analítica cómoda (caso natural para el método de la Secante).
4. **M/G/1 (Pollaczek-Khinchine)**: Captura variabilidad no exponencial mediante el coeficiente de variación $CV$: $W(\lambda) = \frac{\rho(1+CV^2)}{2\mu(1-\rho)} + \frac{1}{\mu}$.
5. **Modelo Empírico (PCHIP)**: Interpolación monótona por tramos cúbicos de Hermite (Fritsch-Carlson) sobre ventanas observadas $(\lambda_i, W_i)$.

## Convergencia Newton-Raphson vs. Secante
- Para M/M/1 con objetivo de latencia media $f(\lambda) = \frac{1}{\mu - \lambda} - T$, definiendo $d_n = \mu - \lambda_n$, la iteración de Newton satisface $d_{n+1} = d_n(2 - T d_n)$. Por tanto converge si y solo si $\lambda_0 \in (\mu - 2/T, \mu)$ con orden cuadrático ($p = 2$). Fuera de ese intervalo escapa del dominio $[0, \mu)$ y el solver reporta `DOMAIN_ESCAPE`.
- El método de la Secante converge con orden superlineal $p \approx 1.618$ sin requerir evaluaciones de derivada ($df_{\text{evals}} = 0$). Cuando no existe derivada analítica (Erlang C o curvas empíricas), evita las evaluaciones extra por diferencias finitas y logra mayor índice de eficiencia $p^{1/\text{costo}}$.
