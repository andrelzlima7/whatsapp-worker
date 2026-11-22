# WhatsApp Scheduler Worker

Use Node.js 22.13 ou superior. Na raiz do repositório, execute `npm ci`, `npm run check`, `npm run build` e `npm test`. Execute `npm start` para rodar o worker compilado ou `npm run dev` para iniciar com recarga automática.

## Operação na VPS

Defina `WORKER_TOKEN` com o mesmo segredo configurado no Spring. O worker escuta por padrão em `127.0.0.1:3000`. Configure `WORKER_HOST` e `WORKER_PORT` se o Spring acessar o serviço por uma interface privada diferente. Todas as rotas, inclusive `/health`, exigem o token.

Os diretórios `WORKER_SESSION_DIR` e `WORKER_EXECUTIONS_DIR` têm como padrão `data/session` e `data/executions`. Use diretórios separados no volume persistente e apenas um processo por conta e volume. Mantenha o segredo e os dados fora do Git. Em `BLOCKED`, corrija a causa da falha de armazenamento antes de reiniciar. Preserve os registros de execução ao recuperar a sessão.

Se a instalação anterior guardava dados na subpasta `whatsapp-worker/`, execute o worker na raiz com `WORKER_SESSION_DIR=whatsapp-worker/data/session` e `WORKER_EXECUTIONS_DIR=whatsapp-worker/data/executions` para reutilizar a sessão e os registros de execução.

Configure o supervisor para enviar `SIGTERM` e permitir a conclusão das operações em andamento. A consulta do Baileys usa um limite de 15 segundos e a chamada de envio tem limite de 30 segundos. Reserve tempo adicional para fechar o socket e sincronizar o disco.

## Decisões de manutenção

- O Spring mantém o agendamento, o prazo efetivo e a política de repetição. O worker valida o prazo recebido e serializa o despacho. A impressão SHA-256 identifica grupo, texto e instante sem gravar o texto.
- O registro por UUID distingue pedido apto a tentar, intenção incerta, confirmação e recusa definitiva. As gravações sincronizam o arquivo temporário, fazem a troca atômica e sincronizam o diretório. A confirmação só é devolvida quando a gravação termina. Em `SEND_UNCERTAIN`, confira o grupo antes de decidir por outro envio.
- A sessão usa um arquivo separado com gravações serializadas, incluindo as chaves do Baileys e o estado de desvinculação. O adaptador foi fixado em Baileys 7.0.0-rc14. Revalide o pareamento e permissões de grupos ao atualizar o SDK.

Os testes automatizados usam Fastify por injeção, diretórios temporários, relógio controlado e um adaptador simulado. A validação em conta e grupo autorizados abrange leitura do QR, restauração da sessão, listagem, permissões e envio real.
