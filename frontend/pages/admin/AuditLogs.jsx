import React from 'react';
import SectionTitle from '../../components/ui/SectionTitle';
import AdminPlaceholder from '../../components/admin/AdminPlaceholder';

const AuditLogs = () => (
  <div className="page-section w-full">
    <SectionTitle title="Audit Logs" subtitle="Immutable operational trail" />
    <AdminPlaceholder
      title="Audit Log Explorer"
      description="Append-only record of every admin mutation and key user action. Powered by GET /admin/audit-logs."
      features={[
        'Filter by action, actor, resource type, severity, and date',
        'Captures trades, reports, bans, node CRUD, and syncs',
        'Severity badges: info / warn / critical',
        'IP and user-agent context per entry',
      ]}
    />
  </div>
);

export default AuditLogs;
