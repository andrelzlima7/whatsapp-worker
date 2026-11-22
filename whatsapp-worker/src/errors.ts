export const errors = {
  INVALID_REQUEST: [400, 'Pedido inválido.'],
  UNAUTHORIZED: [401, 'Autenticação necessária.'],
  NOT_GROUP_MEMBER: [403, 'A conta não participa do grupo.'],
  GROUP_RESTRICTED: [403, 'A conta não pode publicar no grupo.'],
  QR_UNAVAILABLE: [409, 'QR indisponível.'],
  PAIRING_NOT_ALLOWED: [409, 'Pareamento não permitido.'],
  EXECUTION_CONFLICT: [409, 'Dados diferentes para o mesmo ID.'],
  SEND_UNCERTAIN: [409, 'Resultado do envio incerto.'],
  SEND_EXPIRED: [410, 'Prazo de envio encerrado.'],
  BUSY: [429, 'Worker ocupado.'],
  INTERNAL_ERROR: [500, 'Erro interno.'],
  NOT_CONNECTED: [503, 'WhatsApp desconectado.'],
  GROUP_UNAVAILABLE: [503, 'Consulta do grupo indisponível.'],
  GROUPS_UNAVAILABLE: [503, 'Consulta dos grupos indisponível.'],
  SESSION_BLOCKED: [503, 'Sessão bloqueada.'],
} as const

export class WorkerError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1])
  }
}
