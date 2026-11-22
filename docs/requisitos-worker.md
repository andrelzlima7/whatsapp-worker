# Requisitos do worker

## Escopo

- Uma conta de WhatsApp e um worker ativo por instalação.
- Parear por QR, preservar a sessão após reinício, listar os grupos atuais e enviar texto a um grupo por execução.
- O Spring exige login do operador desde a primeira versão. Ele administra grupos, regras, vigência, tentativas e histórico. Para um aviso destinado a três grupos, gera uma execução independente por grupo.
- O worker recebe chamadas internas autenticadas e executa pedidos individuais. Antes de enviar, verifica se a conta participa do grupo e pode publicar nele.

## Sessão

- No primeiro uso, iniciar pareamento automaticamente. O operador autenticado consulta o QR atual pelo Spring. Ao expirar, o QR pode ser consultado novamente.
- Ao reiniciar, carregar a sessão persistida. Uma sessão válida deve voltar sem novo pareamento.
- Em queda temporária, reconectar com espera progressiva. Enquanto indisponível, retornar erro de conexão para novos envios.
- Após desvinculação, informar `LOGGED_OUT` e aguardar a ação “Reconectar WhatsApp”. Iniciar novo pareamento preservando os registros das execuções.
- Se a sessão falhar ao ser gravada, informar `BLOCKED` e suspender novos envios até a recuperação operacional.

## Grupos

O worker consulta a lista completa atual da conta conectada em `GET /groups`. O Spring sincroniza após conectar ou reconectar e quando o operador aciona “Atualizar grupos”. A sincronização cadastra ou atualiza pelo ID externo, torna indisponíveis para novos agendamentos os grupos ausentes de uma consulta completa bem-sucedida e reativa os que voltarem. Falhas mantêm o cadastro anterior. O histórico é preservado.

## Prazo e repetição

- O Spring expira uma ocorrência cuja primeira tentativa começaria com mais de uma hora de atraso em relação ao horário agendado.
- Se configurado, o prazo explícito limita as tentativas. Se for nulo, o Spring calcula uma hora a partir da primeira tentativa. O fim da vigência prevalece quando for o limite mais cedo.
- Antes da primeira chamada, o Spring persiste o prazo efetivo e o UUID da execução. Todas as tentativas reutilizam UUID, grupo, texto e prazo.
- O worker verifica `sendBefore` imediatamente antes de chamar o WhatsApp. No instante do limite ou depois, não inicia o envio. A entrega pode ocorrer depois do limite.
- Falhas comprovadamente anteriores ao envio, como serviço ocupado, desconexão ou falha temporária na consulta do grupo, permitem nova tentativa dentro do prazo. Prazo vencido e falta de permissão encerram a execução.
- Um ID conhecido com outro grupo, texto ou prazo gera conflito. Um envio confirmado retorna o resultado persistido mesmo após o prazo. Esse retorno não inicia outro envio.
- Se houver dúvida após registrar a intenção, preservar `INCERTO` após reinício. O operador confere o grupo antes de decidir sobre qualquer novo envio. O Spring preserva a incerteza se uma tentativa posterior retornar apenas indisponibilidade ou serviço ocupado.

## Critérios de aceite

| Cenário | Resultado esperado |
|---|---|
| Primeira instalação, reinício e perda de conexão | QR inicial, recuperação de sessão válida sem QR e reconexão progressiva após queda temporária |
| Sessão desvinculada ou gravação com falha | `LOGGED_OUT` aguarda ação do operador. `BLOCKED` impede novos envios |
| Novo grupo com a sessão ativa | A atualização manual importa o grupo. Repetir mantém um cadastro por ID. Uma falha mantém a lista anterior |
| Aviso para três grupos com uma falha | Três execuções independentes com resultados próprios |
| Primeira tentativa às 19h30 com prazo nulo e vigência aberta | Prazo fixo às 20h30. Uma tentativa intermediária não estende o limite |
| Validação do grupo termina no instante limite | Worker retorna `SEND_EXPIRED` sem chamar o WhatsApp |
| Primeira tentativa três horas após o horário agendado | Spring registra a execução como expirada |
| Repetição após reinício e prazo vencido | ID confirmado devolve o mesmo resultado. Mudança de conteúdo retorna conflito |
| Queda após persistir a intenção | Após reinício, o ID retorna `SEND_UNCERTAIN` e nenhuma nova chamada ao WhatsApp é feita |
| Perda de resposta seguida de `BUSY` | Spring conserva a incerteza anterior até obter resultado conclusivo |
