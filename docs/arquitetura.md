# Arquitetura da primeira entrega

O worker roda como processo Fastify de longa duração em uma VPS, com uma sessão Baileys ativa e um volume persistente. O Spring chama a API interna por HTTP. PostgreSQL é responsabilidade do Spring e guarda usuários, regras, grupos cadastrados, execuções e histórico.

| Componente do worker | Responsabilidade |
|---|---|
| Aplicação Fastify | Validação, autenticação, rotas e tradução de erros |
| Adaptador WhatsApp | Sessão, QR, grupos, permissão de envio e integração Baileys |
| Despacho | Concorrência, identidade, prazo e transições de execução |
| Persistência | Credenciais da sessão e registros duráveis de execução em diretórios separados |

## Integridade do despacho

Processe um envio por vez. Uma requisição concorrente que não possa ser atendida pode receber `BUSY`, que indica apenas que aquela chamada não iniciou um envio. Antes de chamar Baileys, persista a intenção com identidade da execução e estado incerto. Grave atualizações de forma atômica e durável. Se a intenção não puder ser persistida, interrompa antes do envio. Se o WhatsApp devolver um ID e a confirmação falhar ao persistir, preserve a intenção como incerta.

Guarde uma impressão do pedido para detectar mudanças de grupo, texto ou prazo. Preserve o ID da mensagem quando houver confirmação. Registros ilegíveis devem bloquear o despacho correspondente até investigação. Limites de espera após iniciar a chamada ao WhatsApp produzem incerteza quando o resultado é desconhecido.

## Operação

- Use uma instância por conta e volume. Preserve o diretório de execuções ao reparar ou trocar os arquivos de sessão durante novo pareamento. Preserve os dois diretórios em reinícios e restaurações.
- Use configuração por ambiente e rede privada entre Spring e worker. O Spring autentica o operador, e o worker autentica o serviço chamador.
- Registre códigos de erro, estados de conexão e IDs de execução. Remova ou mascare cabeçalhos de autorização e mantenha tokens, QR, mensagens e credenciais fora dos logs.
- Trate `SIGTERM` e `SIGINT` interrompendo novas requisições, aguardando as operações em andamento e fechando a conexão. Dimensione o prazo de parada para cobrir consulta do grupo, envio e persistência.
- Use `/health` para disponibilidade HTTP e `/connection` para disponibilidade do WhatsApp. Em testes, simule o adaptador e o relógio para exercitar reconexão, reinício, falhas e vencimento sem contato com grupos reais.
