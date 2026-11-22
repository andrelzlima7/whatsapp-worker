# Contrato HTTP do worker

Todas as rotas são internas. Use `Authorization: Bearer <token>`. Respostas JSON usam `Cache-Control: no-store`. Erros têm formato `{"code":"SEND_EXPIRED","message":"Prazo de envio encerrado."}`. Clientes tomam decisões pelo código.

| Método e rota | Resposta |
|---|---|
| `GET /health` | 200 com `{"status":"ok"}` quando o processo HTTP responde |
| `GET /connection` | 200 com `status` e `connectionId` |
| `GET /connection/qr` | 200 com `qrImage`, uma data URL PNG do QR atual. 409 `QR_UNAVAILABLE` quando indisponível |
| `POST /connection/pairing` | 202 ao iniciar novo pareamento a partir de `LOGGED_OUT`. Repetições durante esse pareamento retornam 202. Nos demais estados, 409 `PAIRING_NOT_ALLOWED` |
| `GET /groups` | 200 com `{"groups":[{"id":"123@g.us","name":"Avisos"}]}` após consulta completa. Uma lista vazia indica consulta completa sem grupos |
| `POST /messages` | 200 com `executionId`, `status: "sent"`, `messageId` e `replayed` |

Estados da conexão: `DISCONNECTED`, `CONNECTING`, `AWAITING_QR`, `CONNECTED`, `LOGGED_OUT` e `BLOCKED`. O `connectionId` é um UUID novo a cada conexão bem-sucedida, inclusive após reiniciar. Permanece estável enquanto aquela conexão estiver ativa e é nulo nos demais estados.

## Envio

```json
{
  "executionId": "a801ee32-eacb-451c-a4de-a660a2a674d4",
  "groupId": "123@g.us",
  "text": "O encontro começa às 20h.",
  "sendBefore": "2026-11-25T23:00:00Z"
}
```

Todos os campos são obrigatórios. O ID é um UUID, o destinatário é um ID de grupo WhatsApp e o texto deve conter conteúdo além de espaços. O prazo é um instante RFC 3339 com fuso explícito. Compare prazos pelo instante, de modo que representações equivalentes identifiquem o mesmo pedido. Compare grupo e texto sem alterar o conteúdo enviado. Valide o esquema antes de executar.

Para um ID registrado, verifique a identidade e devolva o resultado persistido antes de avaliar o prazo atual. Use `replayed: true` ao devolver um envio já confirmado. `sent` indica que o adaptador retornou um identificador da mensagem. A entrega e a leitura pelos participantes ficam fora desse resultado.

| HTTP e código | Tratamento pelo Spring |
|---|---|
| 400 `INVALID_REQUEST`, 401 `UNAUTHORIZED` | Corrigir contrato ou configuração |
| 403 `NOT_GROUP_MEMBER`, `GROUP_RESTRICTED` | Encerrar por falta de participação ou permissão |
| 409 `EXECUTION_CONFLICT` | Encerrar por inconsistência de identidade |
| 409 `SEND_UNCERTAIN` | Registrar `INCERTO` e orientar conferência manual |
| 410 `SEND_EXPIRED` | Registrar expiração quando o resultado anterior for conhecido |
| 429 `BUSY`, 503 `NOT_CONNECTED`, `GROUP_UNAVAILABLE` | Repetir o envio com os mesmos dados dentro do prazo e preservar eventual incerteza anterior |
| 503 `GROUPS_UNAVAILABLE` | Preservar grupos cadastrados e permitir nova sincronização |
| 503 `SESSION_BLOCKED` | Sinalizar necessidade de intervenção operacional |
| 500 `INTERNAL_ERROR` ou falha de transporte sem resposta conclusiva | Tratar o envio como potencialmente incerto. Qualquer consulta ou repetição de transporte usa o mesmo ID e os mesmos dados. Se retornar `SEND_UNCERTAIN`, parar as tentativas automáticas |

## Integração de grupos

O Spring consulta `GET /connection` periodicamente. Ao observar um `connectionId` diferente do último sincronizado com sucesso, usa `GET /groups`. Se falhar, mantém o cadastro e pode repetir em outro ciclo. A rota autenticada `POST /api/grupos/sincronizacao` do Spring aciona a mesma conciliação sob demanda.
