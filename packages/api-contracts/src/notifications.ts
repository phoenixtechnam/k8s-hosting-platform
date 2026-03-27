import { z } from 'zod';

export const notificationResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.enum(['info', 'warning', 'error', 'success']),
  title: z.string(),
  message: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  isRead: z.number(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const markNotificationsReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const unreadCountResponseSchema = z.object({
  count: z.number(),
});

export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;
