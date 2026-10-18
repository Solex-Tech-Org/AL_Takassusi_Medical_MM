using { aaml.mc as db } from '../db/schema';

// The service must pull in its definition files, otherwise cds only loads
// this (empty) file and the OData service exposes no entities/actions.
using from './definitions/case-consumption';
using from './definitions/case-sessions';
using from './definitions/nuclear';
using from './definitions/reporting';
using from './definitions/shared-nursing';

@path: '/odata/v4/quality/MaterialConsumptionService'
@requires: 'authenticated-user'
service MaterialConsumptionService {
}
