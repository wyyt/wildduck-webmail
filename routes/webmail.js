'use strict';

const config = require('wild-config');
const express = require('express');
const router = new express.Router();
const apiClient = require('../lib/api-client');
const Joi = require('joi');
const tools = require('../lib/tools');
const fs = require('fs');
const util = require('util');
const humanize = require('humanize');
const SearchString = require('search-string');
const he = require('he');
const addressparser = require('nodemailer/lib/addressparser');

const templates = {
    messageRowTemplate: fs.readFileSync(__dirname + '/../views/partials/messagerow.hbs', 'utf-8')
};

router.get('/send', (req, res) => {
    const schema = Joi.object().keys({
        action: Joi.string()
            .valid('reply', 'replyAll', 'forward', 'send')
            .default('send'),
        to: Joi.string()
            .trim()
            .max(255)
            .empty(''),
        subject: Joi.string()
            .trim()
            .max(255)
            .empty(''),
        refMailbox: Joi.string()
            .hex()
            .length(24)
            .empty(''),
        refMessage: Joi.number()
            .min(1)
            .empty(''),
        draftMailbox: Joi.string()
            .hex()
            .length(24)
            .empty(''),
        draftMessage: Joi.number()
            .min(1)
            .empty(''),
        draft: Joi.boolean()
            .truthy(['Y', 'true', 'yes', 'on', 1])
            .falsy(['N', 'false', 'no', 'off', 0, ''])
            .default(false)
    });

    let result = Joi.validate(req.query, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail/send');
    }

    let action = result.value.action;
    let refMailbox = result.value.refMailbox;
    let refMessage = result.value.refMessage;
    let draftMailbox = result.value.draftMailbox;
    let draftMessage = result.value.draftMessage;
    let isDraft = (result.value.draft && draftMailbox && draftMessage && true) || false;

    apiClient.addresses.list(req.user.id, (err, addresses) => {
        if (err) {
            req.flash('danger', err.message);
            return res.redirect('/webmail');
        }

        let addressList = new Set();
        addresses.forEach(addr => {
            let address = addr.address.substr(0, addr.address.lastIndexOf('@')).replace(/\./g, '') + addr.address.substr(addr.address.lastIndexOf('@'));
            addressList.add(address.replace(/\+[^@]*@/, '@'));
        });

        apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
            if (err) {
                req.flash('danger', err.message);
                res.redirect('/webmail');
                return;
            }

            let getMessageData = done => {
                if (isDraft) {
                    return apiClient.messages.get(req.user.id, draftMailbox, draftMessage, done);
                }

                if (refMailbox && refMessage) {
                    return apiClient.messages.get(req.user.id, refMailbox, refMessage, done);
                }

                return done();
            };

            getMessageData((err, messageData) => {
                if (err) {
                    req.flash('danger', err.message);
                    res.redirect('/webmail');
                    return;
                }

                if (messageData && messageData.meta && messageData.meta.reference) {
                    // override reference info
                    action = messageData.meta.reference.action;
                    refMailbox = messageData.meta.reference.mailbox;
                    refMessage = messageData.meta.reference.id;
                }

                let to = [];
                let cc = [];
                let bcc = [];

                let subject = '';
                let html = [];
                let keepHtmlAsIs = false;

                if (isDraft && messageData) {
                    action = result.value.draftAction || action;
                    to = [].concat(messageData.to || []);
                    cc = [].concat(messageData.cc || []);
                    bcc = [].concat(messageData.bcc || []);
                    subject = messageData.subject;
                    keepHtmlAsIs = true;
                    html = html.concat(messageData.html || []);
                } else if (messageData) {
                    switch (action) {
                        case 'reply':
                        case 'replyAll':
                            {
                                let fromAddress = messageData.from ||
                                    messageData.sender || {
                                        name: '< >'
                                    };

                                let toAddresses = fromAddress.address ? [fromAddress] : [];
                                let ccAddresses = [];

                                if (action === 'replyAll') {
                                    toAddresses = toAddresses.concat(messageData.to || []);
                                    ccAddresses = ccAddresses.concat(messageData.cc || []);
                                }

                                let seenList = new Set();
                                let filterNonSelf = addr => {
                                    if (!addr.address) {
                                        return false;
                                    }

                                    let address = tools.normalizeAddress(addr.address).replace(/\+[^@]*@/, '@');
                                    address = address.substr(0, address.lastIndexOf('@')).replace(/\./g, '') + address.substr(address.lastIndexOf('@'));

                                    if (!addressList.has(address) && !seenList.has(address)) {
                                        if (!addr.name || addr.name.indexOf('@') >= 0) {
                                            addr.name = addr.address;
                                        }
                                        seenList.add(address);
                                        return true;
                                    }
                                    return false;
                                };

                                to = toAddresses.filter(filterNonSelf);
                                cc = ccAddresses.filter(filterNonSelf);

                                subject = 'Re: ' + messageData.subject;
                                html.push(util.format('On {&DATE %s&}, %s wrote:<br/><br/>\n', messageData.date, tools.getAddressesHTML(fromAddress)));
                            }
                            break;
                        case 'forward':
                            subject = 'Fwd: ' + messageData.subject;

                            html.push('Begin forwarded message:<br/><br/>');

                            html.push('<table>');

                            html.push(
                                util.format(
                                    '<tr><th>From</th><td>%s</td></tr>',
                                    tools.getAddressesHTML(
                                        messageData.from ||
                                            messageData.sender || {
                                                name: '< >'
                                            }
                                    )
                                )
                            );

                            if (messageData.subject) {
                                html.push(util.format('<tr><th>Subject</th><td>%s</td></tr>', he.encode(messageData.subject)));
                            }

                            html.push(util.format('<tr><th>Date</th><td>{&DATE %s&}</td></tr>', messageData.date));

                            if (messageData.to) {
                                html.push(util.format('<tr><th>To</th><td>%s</td></tr>', tools.getAddressesHTML(messageData.to)));
                            }

                            if (messageData.cc) {
                                html.push(util.format('<tr><th>Cc</th><td>%s</td></tr>', tools.getAddressesHTML(messageData.cc)));
                            }

                            html.push('</table><br/>');
                            break;
                    }

                    html = html.concat(messageData.html || []);
                } else {
                    to = [].concat(result.value.to || []);
                    subject = result.value.subject;
                }

                let renderAddress = addr => {
                    if (typeof addr === 'string') {
                        return addr.replace(/\bmailto:\/*/g, '');
                    }
                    if (addr.name && addr.name !== addr.address) {
                        return '"' + addr.name.replace(/"\\/g, '') + '" <' + addr.address + '>';
                    }
                    return addr.address;
                };

                res.render('webmail/send', {
                    layout: 'layout-webmail',
                    activeWebmail: true,
                    mailboxes: prepareMailboxList(mailboxes),

                    values: {
                        refMailbox,
                        refMessage,
                        draftMailbox: isDraft ? draftMailbox : '',
                        draftMessage: isDraft ? draftMessage : '',
                        action,
                        subject,
                        to: to.map(renderAddress).join(', '),
                        cc: cc.map(renderAddress).join(', '),
                        bcc: bcc.map(renderAddress).join(', '),
                        draft: isDraft ? 'yes' : ''
                    },

                    messageHtml: JSON.stringify(html).replace(/\//g, '\\u002f'),
                    keepHtmlAsIs,
                    csrfToken: req.csrfToken()
                });
            });
        });
    });
});

router.post('/send', (req, res) => {
    const schema = Joi.object().keys({
        action: Joi.string()
            .valid('reply', 'replyAll', 'forward', 'send', 'draft')
            .default('send'),
        refMailbox: Joi.string()
            .hex()
            .length(24)
            .empty(''),
        refMessage: Joi.number()
            .min(1)
            .empty(''),
        draftMailbox: Joi.string()
            .hex()
            .length(24)
            .empty(''),
        draftMessage: Joi.number()
            .min(1)
            .empty(''),
        to: Joi.string().empty(''),
        cc: Joi.string().empty(''),
        bcc: Joi.string().empty(''),
        subject: Joi.string().empty(''),
        editordata: Joi.string().empty(''),
        draft: Joi.boolean()
            .truthy(['Y', 'true', 'yes', 'on', 1])
            .falsy(['N', 'false', 'no', 'off', 0, ''])
            .default(false),
        userAction: Joi.string()
            .valid('send', 'save')
            .default('send')
    });

    delete req.body._csrf;

    let result = Joi.validate(req.body, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    let showErrors = (errors, disableDefault) => {
        if (!disableDefault) {
            req.flash('danger', 'Failed sending email');
        }

        apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
            if (err) {
                req.flash('danger', err.message);
                return res.redirect('/webmail');
            }

            res.render('webmail/send', {
                layout: 'layout-webmail',
                activeWebmail: true,
                mailboxes: prepareMailboxList(mailboxes),

                values: result.value,
                errors,

                messageHtml: JSON.stringify([].concat(result.value.editordata || [])).replace(/\//g, '\\u002f'),
                keepHtmlAsIs: true,

                csrfToken: req.csrfToken()
            });
        });
    };

    if (result.error) {
        let errors = {};
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                if (!errors[detail.path]) {
                    errors[detail.path] = detail.message;
                }
            });
        }

        return showErrors(errors);
    }

    let userAction = result.value.userAction; // should we send or save draft

    let action = result.value.action;
    let refMailbox = result.value.refMailbox;
    let refMessage = result.value.refMessage;
    let draftMailbox = result.value.draftMailbox;
    let draftMessage = result.value.draftMessage;
    let isDraft = result.value.draft && draftMailbox && draftMessage && true;

    let messageData = {
        isDraft: userAction === 'save', // only set to true when saving a draft
        uploadOnly: userAction !== 'send', // if not sending then just upload the message
        to: result.value.to && addressparser(result.value.to),
        cc: result.value.cc && addressparser(result.value.cc),
        bcc: result.value.bcc && addressparser(result.value.bcc),
        subject: result.value.subject,
        html: result.value.editordata
    };

    if (isDraft && draftMailbox && draftMessage) {
        messageData.draft = { mailbox: draftMailbox, id: draftMessage };
    }

    if (
        userAction === 'send' &&
        (!messageData.to || !messageData.to.length) &&
        (!messageData.cc || !messageData.cc.length) &&
        (!messageData.bcc || !messageData.bcc.length)
    ) {
        return showErrors({
            to: 'No recipients defined'
        });
    }

    switch (action) {
        case 'reply':
        case 'replyAll':
        case 'forward':
            messageData.reference = {
                mailbox: refMailbox,
                id: refMessage,
                action
            };
            messageData.meta = {
                reference: messageData.reference
            };
            break;
    }

    apiClient.messages.submit(req.user.id, messageData, (err, response) => {
        if (err) {
            req.flash('danger', err.message);
            return showErrors({}, true);
        }

        switch (userAction) {
            case 'send':
                req.flash('success', 'Message was queued for delivery');
                break;
            case 'save':
                req.flash('success', 'Message draft was stored');
                return res.redirect('/webmail/' + (response.message ? response.message.mailbox : ''));
        }

        let removeDraft = done => {
            if (!isDraft || 0) {
                return done();
            }
            apiClient.messages.delete(req.user.id, draftMailbox, draftMessage, done);
        };

        if (response.message) {
            return removeDraft(() => res.redirect('/webmail/' + response.message.mailbox + '/audit/' + response.message.id));
        }

        return res.redirect('/webmail/');
    });
});

router.get('/create', (req, res) => {
    apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
        if (err) {
            req.flash('danger', err.message);
            res.redirect('/webmail');
            return;
        }

        res.render('webmail/create', {
            layout: 'layout-webmail',
            activeWebmail: true,
            mailboxes: prepareMailboxList(mailboxes),

            values: {
                name: ''
            },
            parents: getParents(mailboxes, false),
            csrfToken: req.csrfToken()
        });
    });
});

router.post('/create', (req, res) => {
    const schema = Joi.object().keys({
        parent: Joi.string()
            .default('')
            .allow(''),
        name: Joi.string()
            .regex(/\//, { name: 'folder', invert: true })
            .required()
    });

    delete req.body._csrf;

    let result = Joi.validate(req.body, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    let showErrors = (errors, disableDefault) => {
        if (!disableDefault) {
            req.flash('danger', 'Failed creating mailbox');
        }

        apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
            if (err) {
                req.flash('danger', err.message);
                return res.redirect('/webmail');
            }

            res.render('webmail/create', {
                layout: 'layout-webmail',
                activeWebmail: true,
                mailboxes: prepareMailboxList(mailboxes),

                values: result.value,
                errors,

                parents: getParents(mailboxes, false, result.value.parent),

                csrfToken: req.csrfToken()
            });
        });
    };

    if (result.error) {
        let errors = {};

        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                if (!errors[detail.path]) {
                    errors[detail.path] = detail.message;
                }
            });
        }

        return showErrors(errors);
    }

    let path = result.value.parent
        .split('/')
        .concat(result.value.name.split('/') || [])
        .map(name => name.trim())
        .filter(name => name)
        .join('/');

    apiClient.mailboxes.create(
        req.user.id,
        {
            path
        },
        (err, response) => {
            if (err) {
                req.flash('danger', err.message);
                return showErrors({}, true);
            }

            if (response && response.success) {
                req.flash('success', 'Mailbox folder was created');
            }

            return res.redirect('/webmail/' + response.id);
        }
    );
});

/* GET home page. */
router.get('/', renderMailbox);
router.get('/:mailbox', renderMailbox);

router.get('/:mailbox/message/:message', (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .length(24),
        message: Joi.number().min(1)
    });

    let result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
        if (err) {
            return next(err);
        }

        let mailbox = result.value.mailbox || mailboxes[0].id;
        let mailboxExists = false;
        let selectedMailbox = false;
        mailboxes.forEach((entry, i) => {
            entry.index = i + 1;
            if (entry.id === mailbox) {
                entry.selected = true;
                mailboxExists = true;
                selectedMailbox = entry;
            } else if (typeof entry.canMoveTo === 'undefined') {
                entry.canMoveTo = true;
            }
        });

        if (!mailboxExists) {
            return res.redirect('/webmail');
        }

        apiClient.messages.get(req.user.id, mailbox, result.value.message, (err, messageData) => {
            if (err) {
                return next(err);
            }

            if (!messageData) {
                return res.redirect('/webmail');
            }

            if (messageData.draft && selectedMailbox.specialUse !== '\\Trash' && !messageData.encrypted) {
                return res.redirect('/webmail/send?draft=true&action=send&draftMailbox=' + mailbox + '&draftMessage=' + result.value.message);
            }

            let info = [];

            info.push({
                key: 'From',
                isHtml: true,
                value: tools.getAddressesHTML(
                    messageData.from ||
                        messageData.sender || {
                            name: '< >'
                        }
                )
            });

            if (messageData.to) {
                info.push({
                    key: 'To',
                    isHtml: true,
                    value: tools.getAddressesHTML(messageData.to)
                });
            }

            if (messageData.cc) {
                info.push({
                    key: 'Cc',
                    isHtml: true,
                    value: tools.getAddressesHTML(messageData.cc)
                });
            }

            if (messageData.bcc) {
                info.push({
                    key: 'Bcc',
                    isHtml: true,
                    value: tools.getAddressesHTML(messageData.bcc)
                });
            }

            if (messageData.replyTo) {
                info.push({
                    key: 'Reply To',
                    isHtml: true,
                    value: tools.getAddressesHTML(messageData.replyTo)
                });
            }

            info.push({
                key: 'Time',
                isDate: true,
                value: messageData.date
            });

            messageData.html = (messageData.html || []).map(html =>
                html.replace(/attachment:(ATT\d+)/g, (str, aid) => '/webmail/' + mailbox + '/attachment/' + messageData.id + '/' + aid)
            );

            messageData.info = info;

            // make sure that we get the actual unseen count from the server
            apiClient.mailboxes.get(req.user.id, selectedMailbox.id, (err, mailbox) => {
                if (!err && mailbox) {
                    selectedMailbox.unseen = mailbox.unseen;
                }

                let data = {
                    layout: 'layout-webmail',
                    activeWebmail: true,
                    mailboxes: prepareMailboxList(mailboxes),
                    mailbox: selectedMailbox,

                    isTrash: selectedMailbox.specialUse === '\\Trash',

                    message: messageData,
                    messageJson: JSON.stringify(messageData).replace(/\//g, '\\u002f'),

                    csrfToken: req.csrfToken()
                };

                if (selectedMailbox.path === 'INBOX') {
                    data.inboxUnseen = selectedMailbox.unseen;
                }

                res.render('webmail/message', data);
            });
        });
    });
});

router.get('/:mailbox/attachment/:message/:attachment', (req, res) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .lowercase()
            .length(24)
            .required(),
        message: Joi.number()
            .min(1)
            .required(),
        attachment: Joi.string()
            .regex(/^ATT\d+$/i)
            .uppercase()
            .required()
    });

    let result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    apiClient.attachment.get(req, res, req.user.id, result.value.mailbox, result.value.message, result.value.attachment);
});

router.get('/:mailbox/raw/:message.eml', (req, res) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .lowercase()
            .length(24)
            .required(),
        message: Joi.number()
            .min(1)
            .required()
    });

    let result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    apiClient.messages.raw(req, res, req.user.id, result.value.mailbox, result.value.message);
});

router.get('/:mailbox/audit/:message', (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .length(24),
        message: Joi.number().min(1)
    });

    let result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
        if (err) {
            return next(err);
        }

        let mailbox = result.value.mailbox || mailboxes[0].id;
        let mailboxExists = false;
        let selectedMailbox = false;
        mailboxes.forEach((entry, i) => {
            entry.index = i + 1;
            if (entry.id === mailbox) {
                entry.selected = true;
                mailboxExists = true;
                selectedMailbox = entry;
            }
        });

        if (!mailboxExists) {
            return res.redirect('/webmail');
        }
        apiClient.messages.get(req.user.id, mailbox, result.value.message, (err, messageData) => {
            if (err) {
                return next(err);
            }

            if (!messageData) {
                return res.redirect('/webmail');
            }

            let formatTarget = (target, i) => {
                let seq = leftPad((i + 1).toString(16), '0', 3);
                if (typeof target === 'string') {
                    target = {
                        type: 'mail',
                        text: 'Send to',
                        value: target
                    };
                }
                switch (target.type) {
                    case 'mail':
                        return {
                            seq,
                            num: i + 1,
                            text: target.text || 'Forward to',
                            value: target.value
                        };
                    case 'http':
                        return {
                            seq,
                            num: i + 1,
                            text: 'Upload to',
                            value: target.value
                        };
                    case 'relay':
                        return {
                            seq,
                            num: i + 1,
                            text: 'Relay through',
                            value: target.value.mx[0].exchange + (target.value.mxPort && target.value.mxPort !== 25 ? ':' + target.value.mxPort : '')
                        };
                }
            };

            let forwardTargets = [].concat(messageData.forwardTargets || []).map(formatTarget);

            apiClient.messages.getEvents(req.user.id, mailbox, result.value.message, (err, events) => {
                if (err) {
                    return next(err);
                }

                if (!events) {
                    return res.redirect('/webmail');
                }

                res.render('webmail/audit', {
                    layout: 'layout-webmail',
                    activeWebmail: true,
                    mailboxes: prepareMailboxList(mailboxes),
                    mailbox: selectedMailbox,

                    events: events.map(event => {
                        switch (event.action) {
                            case 'STORE':
                                event.actionDescription = 'Message received';
                                event.actionLabel = 'success';
                                break;
                            case 'FORWARD':
                                event.actionDescription = 'Message was queued for forwarding';
                                event.actionLabel = 'info';
                                break;
                            case 'AUTOREPLY':
                                event.actionDescription = 'An autoreply for the message was queued';
                                event.actionLabel = 'info';
                                break;
                            case 'REJECTED':
                                event.actionDescription = 'Message was rejected';
                                event.actionLabel = 'danger';
                                break;
                            case 'ACCEPTED':
                                event.actionDescription = 'Message was accepted';
                                event.actionLabel = 'success';
                                break;
                            case 'QUEUED':
                                event.actionDescription = 'Message was queued for delivery';
                                event.actionLabel = 'success';
                                break;
                            case 'DEFERRED':
                                event.actionDescription = 'Message was temporarily rejected';
                                event.actionLabel = 'warning';
                                break;
                            case 'NOQUEUE':
                                event.actionDescription = 'Failed to queue message';
                                event.actionLabel = 'danger';
                                break;
                            case 'DELETED':
                                event.actionDescription = 'Deleted from queue';
                                event.actionLabel = 'danger';
                                break;
                            case 'DROP':
                                event.actionDescription = 'Dropped from queue';
                                event.actionLabel = 'danger';
                                break;
                            case 'SPAMCHECK':
                                event.actionDescription = 'Messages was checked for spam';
                                event.actionLabel = 'info';
                                break;
                        }

                        if (event.targets) {
                            event.targetList = event.targets.map(formatTarget).filter(target => target);
                        } else if (Array.isArray(event.to) && event.to.length > 1) {
                            event.targetList = event.to.map(formatTarget).filter(target => target);
                            event.toTitle = 'Send to';
                            delete event.to;
                        }

                        event.error = event.error || event.reason;

                        return event;
                    }),
                    messageData,
                    message: result.value.message,
                    forwardTargets
                });
            });
        });
    });
});

router.get('/:mailbox/settings', (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .length(24)
    });

    let result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
        if (err) {
            return next(err);
        }

        let mailbox = result.value.mailbox || mailboxes[0].id;
        let mailboxExists = false;
        let selectedMailbox = false;

        mailboxes.forEach(entry => {
            if (entry.id === mailbox) {
                entry.selected = true;
                mailboxExists = true;
                selectedMailbox = entry;
            }
        });

        if (!mailboxExists) {
            return res.redirect('/webmail');
        }

        res.render('webmail/mailbox', {
            layout: 'layout-webmail',
            activeWebmail: true,
            mailboxes: prepareMailboxList(mailboxes),
            mailbox: selectedMailbox,

            values: {
                name: selectedMailbox.name
            },

            parents: getParents(mailboxes, selectedMailbox),

            isSpecial: selectedMailbox.path === 'INBOX' || selectedMailbox.specialUse,

            isInbox: selectedMailbox.path === 'INBOX',
            isTrash: selectedMailbox.specialUse === '\\Trash',
            isSent: selectedMailbox.specialUse === '\\Sent',
            isJunk: selectedMailbox.specialUse === '\\Junk',

            csrfToken: req.csrfToken()
        });
    });
});

router.post('/:mailbox/settings', (req, res) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .length(24),
        parent: Joi.string()
            .default('')
            .allow(''),
        name: Joi.string()
            .regex(/\//, { name: 'folder', invert: true })
            .required()
    });

    req.body.mailbox = req.params.mailbox;
    delete req.body._csrf;

    let result = Joi.validate(req.body, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    let showErrors = (errors, disableDefault) => {
        if (!disableDefault) {
            req.flash('danger', 'Failed updating mailbox');
        }

        apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
            if (err) {
                req.flash('danger', err.message);
                return res.redirect('/webmail');
            }

            let mailbox = result.value.mailbox || mailboxes[0].id;
            let mailboxExists = false;
            let selectedMailbox = false;

            mailboxes.forEach(entry => {
                if (entry.id === mailbox) {
                    entry.selected = true;
                    mailboxExists = true;
                    selectedMailbox = entry;
                }
            });

            if (!mailboxExists) {
                return res.redirect('/webmail');
            }

            res.render('webmail/mailbox', {
                layout: 'layout-webmail',
                activeWebmail: true,
                mailboxes: prepareMailboxList(mailboxes),
                mailbox: selectedMailbox,

                values: result.value,
                errors,

                parents: getParents(mailboxes, selectedMailbox, result.value.parent),

                isSpecial: selectedMailbox.path === 'INBOX' || selectedMailbox.specialUse,

                isInbox: selectedMailbox.path === 'INBOX',
                isTrash: selectedMailbox.specialUse === '\\Trash',
                isSent: selectedMailbox.specialUse === '\\Sent',
                isJunk: selectedMailbox.specialUse === '\\Junk',

                csrfToken: req.csrfToken()
            });
        });
    };

    if (result.error) {
        let errors = {};

        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                if (!errors[detail.path]) {
                    errors[detail.path] = detail.message;
                }
            });
        }

        return showErrors(errors);
    }

    let path = result.value.parent
        .split('/')
        .concat(result.value.name.split('/') || [])
        .map(name => name.trim())
        .filter(name => name)
        .join('/');

    apiClient.mailboxes.update(
        req.user.id,
        result.value.mailbox,
        {
            path
        },
        (err, response) => {
            if (err) {
                req.flash('danger', err.message);
                return showErrors({}, true);
            }

            if (response && response.success) {
                req.flash('success', 'Mailbox settings were updated');
            }

            return res.redirect('/webmail/' + result.value.mailbox);
        }
    );
});

router.post('/:mailbox/delete', (req, res) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .length(24)
    });

    let result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    apiClient.mailboxes.delete(req.user.id, result.value.mailbox, (err, result) => {
        if (err) {
            req.flash('danger', err.message);
        }

        if (result && result.success) {
            req.flash('success', 'Mailbox folder was deleted');
        }

        return res.redirect('/webmail');
    });
});

function renderMailbox(req, res, next) {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .length(24)
            .allow('starred', 'search')
            .empty(''),
        query: Joi.string()
            .max(255)
            .empty(''),
        next: Joi.string()
            .max(100)
            .empty(''),
        previous: Joi.string()
            .max(100)
            .empty(''),
        page: Joi.number().empty('')
    });

    if (req.params.mailbox) {
        req.query.mailbox = req.params.mailbox;
    }

    let result = Joi.validate(req.query, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/webmail');
    }

    let cursorType, cursorValue;

    if (result.value.next) {
        cursorType = 'next';
        cursorValue = result.value.next;
    } else if (result.value.previous) {
        cursorType = 'previous';
        cursorValue = result.value.previous;
    }

    apiClient.mailboxes.list(req.user.id, true, (err, mailboxes) => {
        if (err) {
            return next(err);
        }

        mailboxes = prepareMailboxList(mailboxes);

        let mailbox = result.value.mailbox || mailboxes[0].id;
        let mailboxExists = false;
        let selectedMailbox = false;
        let searchQuery = result.value.query;

        mailboxes.forEach((entry, i) => {
            if (entry.path === 'INBOX') {
                entry.specialUse = 'INBOX';
            }
            entry.index = i + 1;
            if (entry.id === mailbox) {
                entry.selected = true;
                mailboxExists = true;
                selectedMailbox = entry;
            } else if (typeof entry.canMoveTo === 'undefined') {
                entry.canMoveTo = true;
            }
        });

        if (mailbox === 'search') {
            mailboxExists = true;
            selectedMailbox = {
                id: 'search',
                name: 'Search results',
                icon: 'search',
                showOrigin: true
            };
        }

        if (!mailboxExists) {
            req.flash('danger', 'Selected mailbox does not exist');
            return res.redirect('/webmail');
        }

        selectedMailbox.icon = getIcon(selectedMailbox);

        let makeRequest = done => {
            if (mailbox === 'starred') {
                let data = { next: result.value.next, previous: result.value.previous, page: result.value.page || 1, flagged: true, searchable: true };
                return apiClient.messages.search(req.user.id, data, done);
            } else if (mailbox === 'search') {
                let data = { next: result.value.next, previous: result.value.previous, page: result.value.page || 1, limit: config.www.listSize };

                const searchString = SearchString.parse(searchQuery);
                let keys = searchString.getParsedQuery();
                let text = searchString
                    .getTextSegments()
                    .map(text => text.text)
                    .join(' ');

                Object.keys(keys).forEach(key => {
                    let fkey = key.toLowerCase().trim();
                    if (['from', 'to', 'subject'].includes(fkey)) {
                        data[fkey] = keys[key].join(' ');
                    }
                    switch (fkey) {
                        case 'start':
                        case 'end': {
                            let date = new Date(keys[key].shift());
                            if (date.toString() !== 'Invalid Date') {
                                data.date[fkey] = date.toISOString();
                            }
                            break;
                        }
                    }
                });
                data.query = text;

                return apiClient.messages.search(req.user.id, data, done);
            } else {
                let data = { next: result.value.next, previous: result.value.previous, page: result.value.page || 1, limit: config.www.listSize };
                apiClient.messages.list(req.user.id, mailbox, data, done);
            }
        };

        makeRequest((err, result) => {
            if (err) {
                return next(err);
            }

            res.render('webmail/index', {
                layout: 'layout-webmail',
                activeWebmail: true,
                mailboxes,
                mailbox: selectedMailbox,

                query: searchQuery,

                cursorType,
                cursorValue,
                page: result.page,
                startStr: humanize.numberFormat((result.page - 1) * config.www.listSize + 1 || 0, 0, ',', ' '),
                endStr: humanize.numberFormat(Math.min((result.page - 1) * config.www.listSize + config.www.listSize || 0, result.total || 0), 0, ',', ' '),
                resultsStr: humanize.numberFormat(result.total || 0, 0, ',', ' '),
                nextCursor: result.nextCursor,
                nextPage: result.page + 1,
                previousCursor: result.previousCursor,
                previousPage: Math.max(result.page - 1, 1),

                isInbox: selectedMailbox.path === 'INBOX',
                isTrash: selectedMailbox.specialUse === '\\Trash',
                isSent: selectedMailbox.specialUse === '\\Sent',
                isJunk: selectedMailbox.specialUse === '\\Junk',

                messageRowTemplate: templates.messageRowTemplate,
                messages: result.results.map(message => {
                    if (selectedMailbox.specialUse !== '\\Sent') {
                        message.fromHtml = tools.getAddressesHTML(message.from, true);
                    } else {
                        message.fromHtml = tools.getAddressesHTML(message.to.concat(message.cc), true);
                    }

                    if (selectedMailbox.showOrigin) {
                        let msgMailbox = mailboxes.find(box => box.id === message.mailbox);
                        message.mailboxName = msgMailbox ? msgMailbox.name : false;
                    }

                    return message;
                }),
                csrfToken: req.csrfToken()
            });
        });
    });
}

function getParents(mailboxes, mailbox, parentPath) {
    let parents = new Map();

    mailboxes.forEach((entry, i) => {
        if (!entry.path) {
            return;
        }

        let index = i + 1;

        let parts = entry.path.split('/');

        for (let i = 0; i < parts.length; i++) {
            let path = parts.slice(0, i + 1).join('/');
            let mbox = {
                id: path === entry.path ? entry.id : false,
                index,
                path,
                level: i + 1,
                folder: parts[i],
                name: parts.slice(0, i + 1).join(' / ')
            };
            if (mailbox && entry.path === path && entry.id === mailbox.id) {
                // skip current path
                continue;
            }
            if (!parents.has(path) || path === entry.path) {
                parents.set(path, mbox);
            }
        }
    });

    if (mailbox && !parentPath) {
        parentPath = mailbox.path.split('/');
        parentPath.pop();
        parentPath = parentPath.join('/');
    }

    return Array.from(parents).map(entry => {
        let parent = entry[1];
        if (parent.path === parentPath) {
            // immediate parent of current mailbox
            parent.isParent = true;
        }
        return parent;
    });
}

function getIcon(mailbox) {
    if (mailbox.icon) {
        return mailbox.icon;
    }
    if (mailbox.path === 'INBOX') {
        return 'inbox';
    } else if (mailbox.specialUse) {
        switch (mailbox.specialUse) {
            case '\\Trash':
                return 'trash';
            case '\\Sent':
                return 'send';
            case '\\Junk':
                return 'ban-circle';
            case '\\Drafts':
                return 'edit';
            case '\\Archive':
                return 'hdd';
            case 'Starred':
                return 'star';
        }
    }
    return false;
}

function prepareMailboxList(mailboxes, skipStarred) {
    if (!skipStarred) {
        for (let i = 0, len = mailboxes.length; i < len; i++) {
            if (mailboxes[i].path !== 'INBOX' && mailboxes[i].path.indexOf('INBOX/') < 0) {
                mailboxes.splice(i, 0, {
                    id: 'starred',
                    specialUse: 'Starred',
                    path: '',
                    suffix: '',
                    prefix: '',
                    name: 'Starred',
                    formatted: 'Starred',
                    editable: false,
                    canMoveTo: false,
                    showOrigin: true
                });
                break;
            }
        }
    }

    mailboxes.forEach((mailbox, i) => {
        mailbox.index = i + 1;

        if (mailbox.path) {
            let parts = mailbox.path.split('/');
            let level = 0;

            for (let i = 0; i < parts.length; i++) {
                level++;

                mailbox.formatted = parts[i];
                if (mailbox.path !== 'INBOX') {
                    mailbox.editable = true;
                }

                if (level > 1) {
                    mailbox.prefix = '<div style="padding-left: ' + (level - 1) * 10 + 'px;">';
                    mailbox.suffix = '</div>';
                } else {
                    mailbox.prefix = '';
                    mailbox.suffix = '';
                }
            }
        }

        mailbox.icon = getIcon(mailbox);
    });

    return mailboxes;
}

function leftPad(val, chr, len) {
    return chr.repeat(len - val.toString().length) + val;
}

module.exports = router;
