# WhatsApp Scheduler

O pacote do worker fica na raiz do repositório e usa Node.js 22.13+, TypeScript, Fastify e Baileys. A API Spring será implementada em etapa própria.

Leia, nesta ordem:

1. [Requisitos e critérios de aceite](docs/requisitos-worker.md)
2. [Contrato HTTP](docs/contrato-worker.md)
3. [Arquitetura e operação](docs/arquitetura.md)

Use os requisitos para decidir o comportamento, o contrato para definir a interface HTTP e a arquitetura para orientar a implementação. Se houver conflito que altere o comportamento acordado, leve a divergência ao mantenedor.

Separe a construção do Fastify da abertura da porta HTTP. Mantenha Baileys atrás de uma interface testável. Implemente primeiro sessão e grupos, depois despacho, persistência e tratamento de falhas. Faça alterações rotineiras dentro da tarefa com autonomia.

Na raiz do repositório, execute `npm ci`, `npm run check`, `npm run build` e `npm test`. Execute os cenários de aceite com um adaptador simulado e diretórios temporários. Informe qualquer verificação que ficou pendente. Pareamento e envio reais são verificações manuais com conta e grupo de teste autorizados.

Mantenha tokens, QR, arquivos de sessão e dados de execução fora do Git e dos logs. Use valores fictícios nos exemplos de configuração.
